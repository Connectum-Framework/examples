#!/usr/bin/env -S npx tsx
/**
 * record-demo.ts — Playwright script to record a Coroot UI video demo.
 *
 * Records a ~2–3 minute walkthrough of Coroot showing:
 *   1. Project overview / application list
 *   2. Service Map with hover interactions
 *   3. Service details (order-service metrics)
 *   4. Distributed Traces + span waterfall
 *   5. Logs with trace correlation
 *   6. Inspections / health statuses
 *
 * Prerequisites:
 *   - All services running: `docker compose up -d`
 *   - Traffic generated:    `./scripts/generate-traffic.sh 100`
 *   - Coroot accessible:    http://localhost:8080
 *
 * Usage:
 *   npx tsx scripts/record-demo.ts                        # defaults
 *   COROOT_URL=http://coroot:8080 npx tsx scripts/record-demo.ts
 *
 * Output:
 *   docs/videos/coroot-demo.webm
 */

import { chromium, type Page, type BrowserContext } from "playwright";
import { existsSync, mkdirSync, copyFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Configuration ───────────────────────────────────────────────────────────

const COROOT_URL = process.env.COROOT_URL ?? "http://localhost:8080";
const VIDEO_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../.tmp/video-recording",
);
const OUTPUT_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../docs/videos",
);
const OUTPUT_FILE = resolve(OUTPUT_DIR, "coroot-demo.webm");

const VIEWPORT = { width: 1920, height: 1080 };
const SLOW_PAUSE = 3_000; // pause for viewers to read
const MED_PAUSE = 2_000;
const SHORT_PAUSE = 1_000;
const SCROLL_STEP = 300;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function wait(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Smooth scroll down by `px` pixels. */
async function smoothScroll(page: Page, px: number): Promise<void> {
	const steps = Math.ceil(Math.abs(px) / 80);
	const delta = Math.round(px / steps);
	for (let i = 0; i < steps; i++) {
		await page.mouse.wheel(0, delta);
		await wait(120);
	}
	await wait(SHORT_PAUSE);
}

/** Wait for Coroot to become reachable (up to 60 s). */
async function waitForCoroot(page: Page): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			const res = await page.goto(COROOT_URL, {
				waitUntil: "networkidle",
				timeout: 10_000,
			});
			if (res && res.ok()) return;
		} catch {
			// retry
		}
		await wait(2_000);
	}
	throw new Error(`Coroot not reachable at ${COROOT_URL} after 60 s`);
}

/**
 * Discover the first Coroot project id.
 * Coroot REST API: GET /api/projects → [{ id, name, ... }]
 */
async function discoverProjectId(page: Page): Promise<string> {
	const res = await page.evaluate(async (url: string) => {
		const r = await fetch(`${url}/api/projects`);
		if (!r.ok) return null;
		return r.json();
	}, COROOT_URL);

	if (Array.isArray(res) && res.length > 0) {
		return res[0].id ?? res[0].Id ?? "default";
	}
	// Coroot typically uses "default" if auto-configured
	return "default";
}

/** Click first visible link/button matching text (case-insensitive). */
async function clickText(page: Page, text: string): Promise<boolean> {
	try {
		const loc = page.getByText(text, { exact: false }).first();
		await loc.waitFor({ state: "visible", timeout: 5_000 });
		await loc.click();
		await wait(MED_PAUSE);
		return true;
	} catch {
		return false;
	}
}

/** Hover over an element matching a CSS selector, with fallback. */
async function hoverSelector(
	page: Page,
	selector: string,
	fallbackText?: string,
): Promise<void> {
	try {
		const el = page.locator(selector).first();
		await el.waitFor({ state: "visible", timeout: 5_000 });
		await el.hover();
		await wait(MED_PAUSE);
	} catch {
		if (fallbackText) {
			try {
				await page.getByText(fallbackText, { exact: false }).first().hover();
				await wait(MED_PAUSE);
			} catch {
				// ignore
			}
		}
	}
}

// ─── Recording Scenario ─────────────────────────────────────────────────────

async function recordDemo(): Promise<void> {
	// Ensure output directories exist
	for (const dir of [VIDEO_DIR, OUTPUT_DIR]) {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	}

	console.log("🎬 Launching browser …");
	const browser = await chromium.launch({
		headless: true,
		args: ["--no-sandbox", "--disable-gpu"],
	});

	const context: BrowserContext = await browser.newContext({
		recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
		viewport: VIEWPORT,
		colorScheme: "dark",
		locale: "en-US",
	});

	const page = await context.newPage();

	try {
		// ── Scene 1: Open Coroot (0:00 – 0:15) ──────────────────────────────
		console.log("📍 Scene 1: Opening Coroot …");
		await waitForCoroot(page);
		await wait(SLOW_PAUSE); // let the main page render fully

		const projectId = await discoverProjectId(page);
		console.log(`   Project ID: ${projectId}`);

		// Navigate to project overview — Coroot uses /p/<id>
		await page.goto(`${COROOT_URL}/p/${projectId}`, {
			waitUntil: "networkidle",
			timeout: 15_000,
		});
		await wait(SLOW_PAUSE);

		// ── Scene 2: Service Map (0:15 – 0:45) ──────────────────────────────
		console.log("📍 Scene 2: Service Map …");

		// Try clicking "Service Map" or "Map" in the navigation
		const mapClicked =
			(await clickText(page, "Service Map")) ||
			(await clickText(page, "Map"));

		if (!mapClicked) {
			// Direct navigation fallback
			await page.goto(`${COROOT_URL}/p/${projectId}/map`, {
				waitUntil: "networkidle",
				timeout: 15_000,
			});
		}
		await wait(SLOW_PAUSE);

		// Hover over service nodes on the map (SVG circles / nodes)
		await hoverSelector(page, '[data-service="order-service"]', "order");
		await wait(MED_PAUSE);
		await hoverSelector(
			page,
			'[data-service="inventory-service"]',
			"inventory",
		);
		await wait(MED_PAUSE);

		// Also try generic SVG node hovers (Coroot renders SVG service map)
		const svgNodes = page.locator("svg g.node, svg [class*=service]");
		const nodeCount = await svgNodes.count();
		for (let i = 0; i < Math.min(nodeCount, 4); i++) {
			try {
				await svgNodes.nth(i).hover();
				await wait(SHORT_PAUSE);
			} catch {
				// Some nodes may be off-screen
			}
		}
		await wait(MED_PAUSE);

		// ── Scene 3: Service Details — order-service (0:45 – 1:15) ───────────
		console.log("📍 Scene 3: order-service details …");

		// Click on order-service
		const serviceClicked =
			(await clickText(page, "order-service")) ||
			(await clickText(page, "order"));

		if (!serviceClicked) {
			await page.goto(
				`${COROOT_URL}/p/${projectId}/app/order-service:default`,
				{ waitUntil: "networkidle", timeout: 15_000 },
			);
		}
		await wait(SLOW_PAUSE);

		// Scroll through metrics dashboards
		await smoothScroll(page, SCROLL_STEP * 2); // CPU section
		await wait(MED_PAUSE);
		await smoothScroll(page, SCROLL_STEP * 2); // Memory section
		await wait(MED_PAUSE);
		await smoothScroll(page, SCROLL_STEP * 2); // Latency / Error Rate
		await wait(MED_PAUSE);

		// ── Scene 4: Distributed Traces (1:15 – 1:45) ───────────────────────
		console.log("📍 Scene 4: Distributed Traces …");

		// Try navigation via sidebar / tabs
		const tracesClicked =
			(await clickText(page, "Traces")) ||
			(await clickText(page, "Tracing"));

		if (!tracesClicked) {
			await page.goto(
				`${COROOT_URL}/p/${projectId}/app/order-service:default/traces`,
				{ waitUntil: "networkidle", timeout: 15_000 },
			);
		}
		await wait(SLOW_PAUSE);

		// Click on the first trace in the list
		try {
			const traceRow = page
				.locator("table tbody tr, [class*=trace-row], [class*=TraceRow]")
				.first();
			await traceRow.waitFor({ state: "visible", timeout: 5_000 });
			await traceRow.click();
			await wait(SLOW_PAUSE);

			// Show span waterfall — scroll to see full trace
			await smoothScroll(page, SCROLL_STEP * 2);
			await wait(MED_PAUSE);
		} catch {
			console.log("   ⚠ No trace rows found, continuing …");
			await wait(MED_PAUSE);
		}

		// ── Scene 5: Logs (1:45 – 2:15) ─────────────────────────────────────
		console.log("📍 Scene 5: Logs …");

		const logsClicked = await clickText(page, "Logs");
		if (!logsClicked) {
			await page.goto(
				`${COROOT_URL}/p/${projectId}/app/order-service:default/logs`,
				{ waitUntil: "networkidle", timeout: 15_000 },
			);
		}
		await wait(SLOW_PAUSE);

		// Scroll through log entries
		await smoothScroll(page, SCROLL_STEP);
		await wait(MED_PAUSE);

		// Click a log entry to show details / trace correlation
		try {
			const logRow = page
				.locator("table tbody tr, [class*=log-row], [class*=LogRow]")
				.first();
			await logRow.waitFor({ state: "visible", timeout: 5_000 });
			await logRow.click();
			await wait(SLOW_PAUSE);
		} catch {
			console.log("   ⚠ No log rows found, continuing …");
		}

		// ── Scene 6: Inspections (2:15 – 2:45) ──────────────────────────────
		console.log("📍 Scene 6: Inspections …");

		// Navigate back to project overview for inspections
		const inspClicked =
			(await clickText(page, "Inspections")) ||
			(await clickText(page, "Health")) ||
			(await clickText(page, "Overview"));

		if (!inspClicked) {
			await page.goto(`${COROOT_URL}/p/${projectId}`, {
				waitUntil: "networkidle",
				timeout: 15_000,
			});
		}
		await wait(SLOW_PAUSE);

		// Scroll through inspection results / health statuses
		await smoothScroll(page, SCROLL_STEP * 2);
		await wait(MED_PAUSE);
		await smoothScroll(page, SCROLL_STEP * 2);
		await wait(SLOW_PAUSE);

		// Scroll back to top for a final look
		await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
		await wait(SLOW_PAUSE);

		console.log("✅ Recording scenario complete.");
	} finally {
		// ── Save video ────────────────────────────────────────────────────────
		await page.close(); // triggers video finalization
		const videoPath = await page.video()?.path();
		await context.close();
		await browser.close();

		if (videoPath && existsSync(videoPath)) {
			copyFileSync(videoPath, OUTPUT_FILE);
			// Clean up temp recording
			try {
				unlinkSync(videoPath);
			} catch {
				// ignore
			}
			console.log(`🎥 Video saved: ${OUTPUT_FILE}`);
		} else {
			console.error("❌ Video file not found — recording may have failed.");
			process.exit(1);
		}
	}
}

// ─── Main ────────────────────────────────────────────────────────────────────

recordDemo().catch((err) => {
	console.error("❌ Recording failed:", err);
	process.exit(1);
});
