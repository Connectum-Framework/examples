/**
 * OTel OTLP Export Overhead Benchmark
 *
 * Purpose: Measure the server-side CPU/latency cost of enabling the stock
 *          @connectum/otel export path (BatchSpanProcessor + otlp-transformer
 *          + OTLP/gRPC) under a production-like RPC workload.
 *
 * Why this exists (R1.3, connectum-recommendations.md):
 *   The existing interceptor-overhead scenario runs the OTel interceptor with
 *   the provider UNSET — it emits no-op spans/metrics. That's correct for
 *   measuring interceptor *wiring* cost, but it tells us nothing about the
 *   expensive parts: span serialization and OTLP export. Those only run when
 *   a real provider + exporter is initialized. This scenario fills that gap.
 *
 * Configurations under test:
 *   - Baseline       (port 8081) — no interceptors, no OTel
 *   - OTel export    (port 8085) — full chain + real OTLP/gRPC exporter
 *
 * Load profile:
 *   100 VUs, ramp 30s → 4m steady → 30s ramp down = ~5 min total.
 *   High enough throughput that BatchSpanProcessor exports continuously.
 *
 * Output:
 *   p50/p95/p99 latency per config
 *   Throughput (requests/sec) per config
 *   Export-overhead delta printed in teardown
 *   JSON summary written to /results/otel-export-overhead.json when run via
 *   docker compose (K6_OUT env var).
 */

import { check, sleep } from "k6";
import http from "k6/http";
import { Rate, Trend } from "k6/metrics";

// ============================================================================
// Custom Metrics
// ============================================================================

const baselineDuration = new Trend("baseline_no_otel", true);
const otelExportDuration = new Trend("with_otel_export", true);

const baselineSuccess = new Rate("baseline_success");
const otelExportSuccess = new Rate("otel_export_success");

// ============================================================================
// Test Configuration
// ============================================================================

export const options = {
    scenarios: {
        sustained: {
            executor: "ramping-vus",
            startVUs: 0,
            stages: [
                { duration: "30s", target: 100 }, // ramp up
                { duration: "4m", target: 100 }, // steady load
                { duration: "30s", target: 0 }, // ramp down
            ],
            gracefulRampDown: "10s",
        },
    },

    thresholds: {
        // Both configs should stay healthy under 100 VUs.
        baseline_no_otel: ["p(95)<50"],
        // Stock OTel export adds BatchSpanProcessor + otlp-transformer on the
        // critical path of every 1s batch flush. We set a loose threshold so
        // the scenario reports instead of failing — the delta itself is the
        // deliverable, not a SLA.
        with_otel_export: ["p(95)<200"],

        baseline_success: ["rate>0.99"],
        otel_export_success: ["rate>0.99"],
    },

    tags: {
        test_type: "otel-export-overhead",
        environment: "docker",
    },

    insecureSkipTLSVerify: true,

    // Compact summary — full percentiles for both custom trends.
    summaryTrendStats: ["avg", "min", "med", "max", "p(50)", "p(90)", "p(95)", "p(99)"],
};

// ============================================================================
// Server Ports
// ============================================================================

const BASELINE_PORT = __ENV.BASELINE_PORT || "8081";
const OTEL_EXPORT_PORT = __ENV.OTEL_EXPORT_PORT || "8085";

const BASE_HOST = __ENV.BASE_HOST || "server";
const PROTOCOL = __ENV.PROTOCOL || "https";
const SERVICE_PATH = "/greeter.v1.GreeterService/SayHello";

// ============================================================================
// Helpers
// ============================================================================

function callService(port, configName) {
    const payload = JSON.stringify({
        name: `OtelBench-${configName}-${__VU}-${__ITER}`,
    });

    const response = http.post(`${PROTOCOL}://${BASE_HOST}:${port}${SERVICE_PATH}`, payload, {
        headers: {
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
            "User-Agent": "k6-otel-export-benchmark/1.0",
        },
        tags: {
            name: "SayHello",
            config: configName,
        },
    });

    const success = check(response, {
        [`${configName}: status is 200`]: (r) => r.status === 200,
    });

    return { response, success };
}

// ============================================================================
// Test Scenario
// ============================================================================

export default function () {
    // Alternate baseline / otel-export per iteration to average out JIT/GC
    // jitter. Each iteration touches both configs once, matching the
    // interceptor-overhead.js pattern.
    const testCases = [
        {
            run() {
                const { response, success } = callService(BASELINE_PORT, "baseline");
                baselineDuration.add(response.timings.duration);
                baselineSuccess.add(success);
            },
        },
        {
            run() {
                const { response, success } = callService(OTEL_EXPORT_PORT, "otel_export");
                otelExportDuration.add(response.timings.duration);
                otelExportSuccess.add(success);
            },
        },
    ];

    // Fisher-Yates shuffle — eliminate ordering bias.
    for (let i = testCases.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [testCases[i], testCases[j]] = [testCases[j], testCases[i]];
    }

    for (const testCase of testCases) {
        testCase.run();
    }

    // Small think time to keep the offered load realistic and to give
    // BatchSpanProcessor room to batch exports rather than flush per-request.
    sleep(0.05);
}

// ============================================================================
// Setup (runs once before test)
// ============================================================================

export function setup() {
    console.log("\n  Starting OTel OTLP Export Overhead Benchmark");
    console.log("   Duration: ~5 minutes (30s ramp + 4m steady + 30s ramp down)");
    console.log("   VUs: 100");
    console.log("\n  Configurations to test:");
    console.log(`   1. Baseline (no interceptors, no OTel) - :${BASELINE_PORT}`);
    console.log(`   2. OTel export (full chain + real OTLP/gRPC)  - :${OTEL_EXPORT_PORT}`);
    console.log("\n  Goal: measure p50/p95/p99 latency delta and throughput delta");
    console.log("        caused by the stock @connectum/otel export path.");

    const ports = [
        { port: BASELINE_PORT, name: "Baseline" },
        { port: OTEL_EXPORT_PORT, name: "OTel Export" },
    ];

    console.log("\n  Health checks:\n");
    for (const { port, name } of ports) {
        const healthResponse = http.post(
            `${PROTOCOL}://${BASE_HOST}:${port}/greeter.v1.GreeterService/SayHello`,
            JSON.stringify({ name: "healthcheck" }),
            {
                headers: {
                    "Content-Type": "application/json",
                    "Connect-Protocol-Version": "1",
                },
            },
        );
        if (healthResponse.status === 200) {
            console.log(`   OK   ${name.padEnd(15)} - :${port}`);
        } else {
            console.error(`   FAIL ${name.padEnd(15)} - :${port} (status: ${healthResponse.status})`);
            throw new Error(`Health check failed for ${name} on port ${port}. ` + "Did you start the server with OTEL_EXPORT_ENABLED=1?");
        }
    }

    console.log("\n");
}

// ============================================================================
// Teardown (runs once after test)
// ============================================================================

export function teardown(_data) {
    console.log("\n  OTel OTLP Export Overhead Benchmark completed");
    console.log("\n  Analysis:");
    console.log("   - Compute overhead = with_otel_export(p95) - baseline_no_otel(p95)");
    console.log("   - Compute relative = with_otel_export / baseline_no_otel");
    console.log("   - If relative > 1.5x, investigate otlp-transformer version");
    console.log("     (Connectum recommendations R1.2; see upstream #6221, #6390, #6570)\n");
    console.log("   JSON summary (when running under docker compose):");
    console.log("     examples/performance-test-server/k6/results/otel-export-overhead.json\n");
}
