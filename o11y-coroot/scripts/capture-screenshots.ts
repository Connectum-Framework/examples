#!/usr/bin/env -S npx tsx
/**
 * Automated Coroot UI Screenshot Capture
 *
 * Captures screenshots of Coroot dashboards with live telemetry data
 * from the o11y-coroot demo microservices.
 *
 * Prerequisites:
 *   1. Docker Compose stack running: `docker compose up -d`
 *   2. Traffic generated: `./scripts/generate-traffic.sh`
 *   3. Wait ~2 minutes for Coroot to aggregate data
 *   4. Playwright installed: `npx playwright install chromium`
 *
 * Usage:
 *   npx tsx scripts/capture-screenshots.ts
 *   npx tsx scripts/capture-screenshots.ts --base-url http://localhost:8080
 */

import { chromium, type Page, type Browser } from "playwright";
import { mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = resolve(__dirname, "../docs/screenshots");
const baseUrlIdx = process.argv.indexOf("--base-url");
const BASE_URL = baseUrlIdx !== -1 && process.argv[baseUrlIdx + 1]
    ? process.argv[baseUrlIdx + 1]
    : "http://localhost:8080";

const VIEWPORT = { width: 1920, height: 1080 };
const LOAD_TIMEOUT = 30_000;

interface ScreenshotTask {
    name: string;
    filename: string;
    navigate: (page: Page, projectId: string) => Promise<void>;
}

/** Detect the Coroot project ID from the redirect URL */
async function detectProjectId(page: Page): Promise<string> {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: LOAD_TIMEOUT });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(3000);
    const url = page.url();
    const match = url.match(/\/p\/([^/]+)/);
    return match?.[1] ?? "default";
}

/** Dismiss the "Supercharge Coroot with AI" modal and any overlays via DOM removal */
async function dismissOverlays(page: Page): Promise<void> {
    await page.evaluate(() => {
        // Remove all Vuetify overlay scrims
        document.querySelectorAll(".v-overlay--active, .v-overlay__scrim").forEach((el) => {
            el.remove();
        });
        // Remove the Coroot Cloud promo dialog
        document.querySelectorAll(".v-dialog--active, .v-dialog__content--active").forEach((el) => {
            el.remove();
        });
        // Remove any remaining overlay containers
        document.querySelectorAll("[class*='overlay']").forEach((el) => {
            const htmlEl = el as HTMLElement;
            if (htmlEl.style.position === "fixed" || htmlEl.classList.contains("v-overlay")) {
                el.remove();
            }
        });
    });
    await page.waitForTimeout(300);
}

/** Hide the "No metrics found" warning banner and promo buttons */
async function hideWarningBanner(page: Page): Promise<void> {
    await page.evaluate(() => {
        // Hide alert banners
        document.querySelectorAll(".v-alert, [class*='alert']").forEach((el) => {
            (el as HTMLElement).style.display = "none";
        });
        // Hide node-agent / OTel integration buttons
        const buttons = document.querySelectorAll("button, .v-btn");
        buttons.forEach((btn) => {
            if (
                btn.textContent?.includes("Install node-agent") ||
                btn.textContent?.includes("Integrate OpenTelemetry")
            ) {
                (btn as HTMLElement).style.display = "none";
            }
        });
    });
}

/** Navigate to a URL, wait for load, dismiss modals, and clean up UI noise */
async function navigateAndPrepare(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: "networkidle", timeout: LOAD_TIMEOUT });
    await page.waitForTimeout(2000);
    await dismissOverlays(page);
    await page.waitForTimeout(1000);
    await dismissOverlays(page);
    await hideWarningBanner(page);
    await page.waitForTimeout(1500);
    await dismissOverlays(page);
}

/** Click a tab by text, with fallback tolerance */
async function clickTab(page: Page, text: string): Promise<boolean> {
    const tab = page.locator(`[role='tab']:has-text('${text}')`).first();
    if (await tab.isVisible({ timeout: 3000 }).catch(() => false)) {
        await tab.click({ force: true });
        await page.waitForTimeout(3000);
        await dismissOverlays(page);
        await hideWarningBanner(page);
        return true;
    }
    return false;
}

/** Find the order-service application href from the Applications page */
async function findOrderServiceHref(page: Page): Promise<string | null> {
    return page.evaluate(() => {
        const links = document.querySelectorAll("table a");
        for (const link of links) {
            if (link.textContent?.includes("order-service")) {
                return link.getAttribute("href");
            }
        }
        return null;
    });
}

/** Enable the "monitoring" checkbox on Applications/Service Map pages to show all services */
async function enableMonitoringCheckbox(page: Page): Promise<void> {
    // Get initial row count
    const initialRows = await page.locator("table tbody tr").count().catch(() => 0);

    // Click the monitoring checkbox label
    const label = page.locator("label:has-text('monitoring')").first();
    if (!(await label.isVisible({ timeout: 3000 }).catch(() => false))) {
        console.log("     ⚠ monitoring checkbox not found");
        return;
    }

    await label.click({ force: true });
    await page.waitForTimeout(4000);
    await dismissOverlays(page);

    const newRows = await page.locator("table tbody tr").count().catch(() => 0);

    // If clicking DECREASED rows, we unchecked it — click again to re-check
    if (newRows < initialRows) {
        console.log(`     ℹ Checkbox unchecked (${initialRows} → ${newRows} rows), re-clicking`);
        await label.click({ force: true });
        await page.waitForTimeout(4000);
        await dismissOverlays(page);
    }

    const finalRows = await page.locator("table tbody tr").count().catch(() => 0);
    console.log(`     ℹ Monitoring checkbox enabled, table has ${finalRows} row(s)`);
}

/** Click a sidebar navigation link by text */
async function clickSidebarLink(page: Page, text: string): Promise<boolean> {
    const selectors = [
        `nav a:has-text('${text}')`,
        `.v-navigation-drawer a:has-text('${text}')`,
        `a.v-list-item:has-text('${text}')`,
        `.v-list-item:has-text('${text}')`,
        `[class*='sidebar'] a:has-text('${text}')`,
        `a:has-text('${text}')`,
    ];

    for (const selector of selectors) {
        const link = page.locator(selector).first();
        if (await link.isVisible({ timeout: 2000 }).catch(() => false)) {
            await link.click({ force: true });
            await page.waitForLoadState("networkidle", { timeout: LOAD_TIMEOUT });
            await page.waitForTimeout(3000);
            await dismissOverlays(page);
            await hideWarningBanner(page);
            return true;
        }
    }
    return false;
}

/** Select heatmap time range by dragging across the chart */
async function selectHeatmapRange(page: Page): Promise<void> {
    const chart = page.locator("canvas, svg, [class*='chart'], [class*='heatmap']").first();
    if (await chart.isVisible({ timeout: 3000 }).catch(() => false)) {
        const box = await chart.boundingBox();
        if (box) {
            await page.mouse.move(box.x + box.width * 0.02, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width * 0.98, box.y + box.height / 2, { steps: 10 });
            await page.mouse.up();
            await page.waitForTimeout(3000);
            await dismissOverlays(page);
        }
    }
}

const tasks: ScreenshotTask[] = [
    {
        name: "Service Map",
        filename: "screenshot-service-map.png",
        navigate: async (page, projectId) => {
            // Navigate to Service Map page
            await navigateAndPrepare(page, `${BASE_URL}/p/${projectId}/map`);
            await page.waitForTimeout(3000);

            // Enable "monitoring" checkbox to show all services (including infra)
            await enableMonitoringCheckbox(page);

            // Wait for the service map graph to render
            await page.waitForTimeout(3000);
        },
    },
    {
        name: "Service Overview - order-service",
        filename: "screenshot-order-service-overview.png",
        navigate: async (page, projectId) => {
            // Find the order-service application URL by scanning the Applications list HTML
            // Navigate to applications and enable monitoring checkbox to see all services
            await navigateAndPrepare(page, `${BASE_URL}/p/${projectId}/applications`);

            // Try to find order-service href with and without monitoring checkbox
            let orderServiceHref = await findOrderServiceHref(page);

            if (!orderServiceHref) {
                // Toggle monitoring checkbox and retry
                await enableMonitoringCheckbox(page);
                orderServiceHref = await findOrderServiceHref(page);
            }

            if (orderServiceHref) {
                console.log(`     ℹ Found order-service at: ${orderServiceHref}`);
                await navigateAndPrepare(page, `${BASE_URL}${orderServiceHref}`);
                await page.waitForTimeout(2000);

                // Navigate to NET tab for RED metrics (request rate, latency, errors on connections)
                // NET shows network-level metrics between services which include request/response data
                // Fallback chain: NET → NODE.JS → INSTANCES → CPU
                const netClicked = await clickTab(page, "NET");
                if (netClicked) {
                    console.log("     ✓ Showing NET tab with connection metrics (request rate, latency)");
                } else {
                    const nodeClicked = await clickTab(page, "NODE.JS");
                    if (!nodeClicked) {
                        const instClicked = await clickTab(page, "INSTANCES");
                        if (!instClicked) {
                            await clickTab(page, "CPU");
                        }
                    }
                }
                return;
            }

            // Fallback: navigate to Traces filtered by order-service
            console.log("     ℹ order-service not in Applications, showing Traces overview as alternative");
            await navigateAndPrepare(page, `${BASE_URL}/p/${projectId}/traces`);

            const serviceLink = page.locator("a:has-text('order-service')").first();
            if (await serviceLink.isVisible({ timeout: 5000 }).catch(() => false)) {
                await serviceLink.click({ force: true });
                await page.waitForLoadState("networkidle", { timeout: LOAD_TIMEOUT });
                await page.waitForTimeout(3000);
                await dismissOverlays(page);
                await hideWarningBanner(page);
            }

            await clickTab(page, "OVERVIEW");
        },
    },
    {
        name: "Distributed Traces",
        filename: "screenshot-traces.png",
        navigate: async (page, projectId) => {
            // Navigate to Traces overview
            await navigateAndPrepare(page, `${BASE_URL}/p/${projectId}/traces`);

            // Click into CreateOrder to show filtered view
            const spanLink = page.locator("a:has-text('OrderService/CreateOrder')").first();
            if (await spanLink.isVisible({ timeout: 5000 }).catch(() => false)) {
                await spanLink.click({ force: true });
                await page.waitForLoadState("networkidle", { timeout: LOAD_TIMEOUT });
                await page.waitForTimeout(3000);
                await dismissOverlays(page);
                await hideWarningBanner(page);

                // Switch to TRACES tab to show trace list
                const tracesTabClicked = await clickTab(page, "TRACES");
                if (tracesTabClicked) {
                    await selectHeatmapRange(page);
                }
            }
        },
    },
    {
        name: "Trace Detail",
        filename: "screenshot-trace-detail.png",
        navigate: async (page, projectId) => {
            // Navigate to Traces, filter by CreateOrder
            await navigateAndPrepare(page, `${BASE_URL}/p/${projectId}/traces`);

            const spanLink = page.locator("a:has-text('OrderService/CreateOrder')").first();
            if (await spanLink.isVisible({ timeout: 5000 }).catch(() => false)) {
                await spanLink.click({ force: true });
                await page.waitForLoadState("networkidle", { timeout: LOAD_TIMEOUT });
                await page.waitForTimeout(3000);
                await dismissOverlays(page);
                await hideWarningBanner(page);
            }

            // Switch to TRACES tab
            const tracesTabClicked = await clickTab(page, "TRACES");

            if (tracesTabClicked) {
                await selectHeatmapRange(page);

                // Find a trace with duration >= 2ms (indicates cross-service call with child spans)
                const traceRows = page.locator("table tbody tr");
                const rowCount = await traceRows.count();
                console.log(`     ℹ Found ${rowCount} trace row(s) in table`);

                let targetIdx = -1;
                for (let i = 0; i < Math.min(rowCount, 30); i++) {
                    const durationCell = traceRows.nth(i).locator("td").last();
                    const durationText = await durationCell.textContent().catch(() => "");
                    const durationMs = parseFloat(durationText?.replace(/[^\d.]/g, "") ?? "0");
                    if (durationMs >= 2) {
                        targetIdx = i;
                        console.log(`     ℹ Selected trace at row ${i} with duration ${durationText} (multi-span)`);
                        break;
                    }
                }

                // If no long trace found, try the first one anyway
                if (targetIdx === -1) {
                    targetIdx = 0;
                    console.log("     ℹ No long-duration trace found, using first trace");
                }

                const traceIdLinks = page.locator("table tbody tr td:first-child a");
                const linkCount = await traceIdLinks.count();

                if (linkCount > targetIdx) {
                    await traceIdLinks.nth(targetIdx).click({ force: true });
                    await page.waitForTimeout(5000);
                    await dismissOverlays(page);
                    await hideWarningBanner(page);

                    const currentUrl = page.url();
                    console.log(`     ℹ Trace detail URL: ${currentUrl}`);

                    // Wait for span waterfall to render
                    await page.waitForTimeout(2000);

                    // Try to click on a span row to expand and show attributes
                    // Look for span rows in the waterfall view
                    const spanRows = page.locator("table tbody tr, [class*='waterfall'] [class*='row'], [class*='span-row']");
                    const spanCount = await spanRows.count();
                    console.log(`     ℹ Found ${spanCount} span element(s) in trace detail`);

                    if (spanCount > 0) {
                        // Click the first span row to expand attributes
                        await spanRows.first().click({ force: true }).catch(() => {});
                        await page.waitForTimeout(2000);
                        await dismissOverlays(page);
                    }
                } else {
                    console.log("     ⚠ No trace links found in table, capturing trace list");
                }
            } else {
                console.log("     ⚠ TRACES tab not found, capturing current view");
            }
        },
    },
    {
        name: "Logs View",
        filename: "screenshot-logs.png",
        navigate: async (page, projectId) => {
            await navigateAndPrepare(page, `${BASE_URL}/p/${projectId}/logs`);

            // Enable OpenTelemetry log source for trace correlation
            const otelLogs = page.locator("label:has-text('OpenTelemetry')").first();
            if (await otelLogs.isVisible({ timeout: 2000 }).catch(() => false)) {
                const input = otelLogs.locator("input[type='checkbox']");
                const isChecked = await input.isChecked().catch(() => false);
                if (!isChecked) {
                    await otelLogs.click({ force: true });
                    await page.waitForTimeout(500);
                }
            }

            // Also enable container logs
            const containerLogs = page.locator("label:has-text('Container logs')").first();
            if (await containerLogs.isVisible({ timeout: 2000 }).catch(() => false)) {
                const input = containerLogs.locator("input[type='checkbox']");
                const isChecked = await input.isChecked().catch(() => false);
                if (!isChecked) {
                    await containerLogs.click({ force: true });
                    await page.waitForTimeout(500);
                }
            }

            // Click "Show logs" button
            const showLogsBtn = page.locator("button:has-text('Show logs')").first();
            if (await showLogsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                await showLogsBtn.click({ force: true });
                await page.waitForTimeout(5000);
                await dismissOverlays(page);
                await hideWarningBanner(page);
            }

            // Scroll to top of log table to show most recent entries
            await page.evaluate(() => {
                const table = document.querySelector("table");
                if (table) table.scrollTop = 0;
            });
            await page.waitForTimeout(1000);

            // Click on a log entry to show the detail modal with OTel attributes
            // and "Show the trace" button (trace correlation).
            // The modal shows: Message, Attributes (service.name, otel.scope, etc.), "Show the trace" btn
            const rows = page.locator("table tbody tr");
            const rowCount = await rows.count();

            // Try each log entry until we find one with the "Show the trace" button
            for (let i = 0; i < Math.min(rowCount, 15); i++) {
                await rows.nth(i).click({ force: true });
                await page.waitForTimeout(2000);

                // Check for "Show the trace" button (appears for OTel logs with trace_id)
                const showTraceBtn = page.locator("button:has-text('Show the trace'), a:has-text('Show the trace')").first();
                if (await showTraceBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                    console.log(`     ✓ Found trace-correlated log at row ${i} with "Show the trace" button`);
                    break;
                }

                // Also check with partial text match
                const traceText = page.locator("text=Show the trace").first();
                if (await traceText.isVisible({ timeout: 500 }).catch(() => false)) {
                    console.log(`     ✓ Found trace correlation at row ${i}`);
                    break;
                }

                // Close modal and try next entry
                await page.keyboard.press("Escape");
                await page.waitForTimeout(500);
            }
        },
    },
    {
        name: "Inspections/Health",
        filename: "screenshot-inspections.png",
        navigate: async (page, projectId) => {
            // Show Applications list with health status indicators (green/red)
            // This is the Coroot CE equivalent of an inspections/health view
            await navigateAndPrepare(page, `${BASE_URL}/p/${projectId}/applications`);

            // Enable "monitoring" checkbox to show all services including infra
            await enableMonitoringCheckbox(page);
            await page.waitForTimeout(2000);

            // Check if we have application rows with status indicators
            const appCount = await page.locator("table tbody tr").count();
            console.log(`     ℹ Applications list has ${appCount} row(s) with health statuses`);

            if (appCount === 0) {
                // Fallback 1: try the Incidents page
                console.log("     ℹ No applications found, trying Incidents page");
                const incidentsClicked = await clickSidebarLink(page, "Incidents");
                if (!incidentsClicked) {
                    // Fallback 2: try Deployments page which also shows service health
                    console.log("     ℹ Incidents not found, trying Deployments page");
                    await navigateAndPrepare(page, `${BASE_URL}/p/${projectId}/deployments`);
                    await page.waitForTimeout(3000);
                }
            }
        },
    },
];

async function main(): Promise<void> {
    console.log("🎬 Coroot UI Screenshot Capture");
    console.log(`   Base URL: ${BASE_URL}`);
    console.log(`   Output:   ${SCREENSHOTS_DIR}`);
    console.log(`   Viewport: ${VIEWPORT.width}x${VIEWPORT.height}`);
    console.log();

    if (!existsSync(SCREENSHOTS_DIR)) {
        mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }

    let browser: Browser | null = null;

    try {
        browser = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox"],
        });

        const context = await browser.newContext({
            viewport: VIEWPORT,
            deviceScaleFactor: 1,
        });

        const page = await context.newPage();

        // Verify Coroot is reachable
        console.log("🔍 Checking Coroot availability...");
        try {
            const response = await page.goto(`${BASE_URL}/health`, { timeout: 10_000 });
            if (!response?.ok()) {
                throw new Error(`Coroot health check failed: ${response?.status()}`);
            }
            console.log("✅ Coroot is reachable\n");
        } catch {
            console.error("❌ Cannot reach Coroot at", BASE_URL);
            console.error("   Make sure the stack is running: docker compose up -d");
            process.exit(1);
        }

        // Detect project ID
        console.log("🔍 Detecting project ID...");
        const projectId = await detectProjectId(page);
        console.log(`   Project ID: ${projectId}\n`);

        // Dismiss initial modal on first load
        await dismissOverlays(page);

        // Capture each screenshot
        const results: { name: string; success: boolean; error?: string }[] = [];

        for (const task of tasks) {
            const filepath = resolve(SCREENSHOTS_DIR, task.filename);
            console.log(`📸 Capturing: ${task.name}...`);

            try {
                await task.navigate(page, projectId);

                await page.screenshot({
                    path: filepath,
                    fullPage: false,
                    type: "png",
                });

                console.log(`   ✅ Saved: ${task.filename}`);
                results.push({ name: task.name, success: true });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`   ❌ Failed: ${msg}`);
                results.push({ name: task.name, success: false, error: msg });
            }
        }

        await context.close();

        // Summary
        console.log("\n─── Summary ───────────────────────────────────────");
        const succeeded = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;
        console.log(`✅ Captured: ${succeeded}/${results.length}`);
        if (failed > 0) {
            console.log(`❌ Failed:   ${failed}/${results.length}`);
            for (const r of results.filter((r) => !r.success)) {
                console.log(`   - ${r.name}: ${r.error}`);
            }
        }
        console.log(`\n📁 Screenshots saved to: ${SCREENSHOTS_DIR}`);
    } finally {
        await browser?.close();
    }
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
