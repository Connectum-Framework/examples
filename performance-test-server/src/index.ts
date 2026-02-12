/**
 * Performance Test Server
 *
 * Dedicated server for k6 performance benchmarking.
 *
 * Runs 5 parallel servers with different interceptor configurations:
 * - Port 8081: Baseline (no interceptors)
 * - Port 8082: Validation only
 * - Port 8083: Logger only
 * - Port 8084: OTel (tracing + metrics) only
 * - Port 8080: Full chain (all interceptors)
 *
 * This allows measuring the overhead of each interceptor individually.
 *
 * Uses the new createServer() API with explicit lifecycle control.
 */

import { createServer } from "@connectum/core";
import type { CreateServerOptions, Server } from "@connectum/core";
import {
    createDefaultInterceptors,
    createLoggerInterceptor,
    createValidationInterceptor,
} from "@connectum/interceptors";
import { createOtelInterceptor } from "@connectum/otel";
import { benchmarkServiceRoutes } from "./services/benchmarkService.ts";

console.log("🚀 Starting Performance Test Server...\n");

// ============================================================================
// Configuration 1: Baseline (no interceptors)
// ============================================================================

const baselineOptions: CreateServerOptions = {
    services: [benchmarkServiceRoutes],
    port: 8081,
    host: "0.0.0.0",
    interceptors: [], // NO interceptors - pure baseline
};

// ============================================================================
// Configuration 2: Validation only
// ============================================================================

const validationOptions: CreateServerOptions = {
    services: [benchmarkServiceRoutes],
    port: 8082,
    host: "0.0.0.0",
    interceptors: [createValidationInterceptor()], // ONLY validation
};

// ============================================================================
// Configuration 3: Logger only
// ============================================================================

const loggerOptions: CreateServerOptions = {
    services: [benchmarkServiceRoutes],
    port: 8083,
    host: "0.0.0.0",
    interceptors: [
        createLoggerInterceptor({
            level: "error", // Minimal logging to reduce overhead
            skipHealthCheck: true,
        }),
    ],
};

// ============================================================================
// Configuration 4: OTel (tracing + metrics) only
// ============================================================================

const otelOptions: CreateServerOptions = {
    services: [benchmarkServiceRoutes],
    port: 8084,
    host: "0.0.0.0",
    interceptors: [
        createOtelInterceptor({
            filter: ({ service }) => !service.includes("grpc.health"),
        }),
    ],
};

// ============================================================================
// Configuration 5: Full chain (all interceptors)
// ============================================================================

const fullChainOptions: CreateServerOptions = {
    services: [benchmarkServiceRoutes],
    port: 8080,
    host: "0.0.0.0",
    interceptors: [
        ...createDefaultInterceptors({
            errorHandler: {
                logErrors: true,
                includeStackTrace: true,
            },
            logger: {
                level: "error", // Minimal logging
                skipHealthCheck: true,
            },
            serializer: true,
            validation: true,
            redact: false, // Skip for performance (no sensitive data in benchmark)
        }),
        createOtelInterceptor({
            filter: ({ service }) => !service.includes("grpc.health"),
        }),
    ],
};

// ============================================================================
// Start all servers
// ============================================================================

console.log("📊 Starting 5 server configurations:\n");

try {
    // createServer() is synchronous - creates unstarted server instances
    const servers: Server[] = [
        createServer(baselineOptions),
        createServer(validationOptions),
        createServer(loggerOptions),
        createServer(otelOptions),
        createServer(fullChainOptions),
    ];

    // start() is async - start all servers in parallel
    await Promise.all(servers.map((server) => server.start()));

    console.log("\n✅ All servers started successfully!\n");
    console.log("Port | Configuration");
    console.log("-----|-----------------------------------");
    console.log("8081 | Baseline (no interceptors)");
    console.log("8082 | Validation only");
    console.log("8083 | Logger only");
    console.log("8084 | OTel (tracing + metrics) only");
    console.log("8080 | Full chain (all interceptors)");

    console.log("\n🧪 Ready for k6 benchmarks!");
    console.log("\nRun benchmarks with:");
    console.log("  k6 run tests/performance/scenarios/basic-load.js");
    console.log("  k6 run tests/performance/scenarios/stress-test.js");
    console.log("  k6 run tests/performance/scenarios/spike-test.js");
    console.log("  k6 run tests/performance/scenarios/interceptor-overhead.js");

    console.log("\n🛑 Press Ctrl+C to shutdown all servers\n");

    // ============================================================================
    // Graceful shutdown on SIGTERM/SIGINT
    // ============================================================================

    const shutdownHandler = async () => {
        console.log("\n🛑 Shutting down all servers gracefully...");

        await Promise.all(servers.map((server) => server.stop()));

        console.log("✅ All servers stopped");
        process.exit(0);
    };

    process.on("SIGTERM", shutdownHandler);
    process.on("SIGINT", shutdownHandler);
} catch (error) {
    console.error("❌ Failed to start servers:", error);
    process.exit(1);
}
