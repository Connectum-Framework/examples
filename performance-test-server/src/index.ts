/**
 * Performance Test Server
 *
 * Dedicated server for k6 performance benchmarking.
 *
 * Runs up to 6 parallel servers with different interceptor configurations:
 * - Port 8081: Baseline (no interceptors)
 * - Port 8082: Validation only
 * - Port 8083: Logger only
 * - Port 8084: OTel (tracing + metrics) only (no-op exporter)
 * - Port 8080: Full chain (all interceptors, no-op exporter)
 * - Port 8085: OTel export — full chain + real OTLP exporter to a collector
 *              (enabled only when OTEL_EXPORT_ENABLED=1, i.e. the OTel collector
 *              is running; otherwise this port is skipped).
 *
 * This allows measuring the overhead of each interceptor individually, plus
 * the end-to-end overhead of real OTLP export on port 8085.
 *
 * Uses the new createServer() API with explicit lifecycle control.
 */

import { createServer } from "@connectum/core";
import type { CreateServerOptions, Server } from "@connectum/core";
import {
    createDefaultInterceptors,
    createLoggerInterceptor,
} from "@connectum/interceptors";
import { createOtelInterceptor, initProvider, shutdownProvider } from "@connectum/otel";
import { benchmarkServiceRoutes } from "./services/benchmarkService.ts";

// Optional TLS: set TLS_DIR env var to enable HTTPS (required for HTTP/1.1 compatibility)
const tlsConfig = process.env.TLS_DIR
    ? { dirPath: process.env.TLS_DIR }
    : undefined;

console.log("Starting Performance Test Server...\n");

// ============================================================================
// Configuration 1: Baseline (no interceptors)
// ============================================================================

const baselineOptions: CreateServerOptions = {
    services: [benchmarkServiceRoutes],
    port: 8081,
    host: "0.0.0.0",
    tls: tlsConfig,
    interceptors: [], // NO interceptors - pure baseline
};

// ============================================================================
// Configuration 2: Validation only
// ============================================================================

const validationOptions: CreateServerOptions = {
    services: [benchmarkServiceRoutes],
    port: 8082,
    host: "0.0.0.0",
    tls: tlsConfig,
    interceptors: createDefaultInterceptors({
        errorHandler: false,
        timeout: false,
        bulkhead: false,
        circuitBreaker: false,
        retry: false,
        validation: true,
        serializer: false,
    }),
};

// ============================================================================
// Configuration 3: Logger only
// ============================================================================

const loggerOptions: CreateServerOptions = {
    services: [benchmarkServiceRoutes],
    port: 8083,
    host: "0.0.0.0",
    tls: tlsConfig,
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
    tls: tlsConfig,
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
    tls: tlsConfig,
    interceptors: [
        ...createDefaultInterceptors({
            errorHandler: {
                logErrors: true,
                includeStackTrace: true,
            },
            serializer: true,
            validation: true,
        }),
        createLoggerInterceptor({
            level: "error",
            skipHealthCheck: true,
        }),
        createOtelInterceptor({
            filter: ({ service }) => !service.includes("grpc.health"),
        }),
    ],
};

// ============================================================================
// Configuration 6 (OPTIONAL): OTel export — full chain + real OTLP exporter
// ============================================================================
//
// Enabled only when OTEL_EXPORT_ENABLED=1.
//
// Uses @connectum/otel provider with env-driven OTLP/gRPC exporter pointed at
// a local OTel Collector. This measures the stock OTel-JS export path
// (BatchSpanProcessor + @opentelemetry/otlp-transformer serialization +
// @grpc/grpc-js wire), i.e. exactly what production users pay.
//
// The OTLP exporter and BatchSpanProcessor options are read from standard
// OTEL_* env vars (see @connectum/otel config.ts):
//   OTEL_SERVICE_NAME, OTEL_TRACES_EXPORTER, OTEL_METRICS_EXPORTER,
//   OTEL_LOGS_EXPORTER, OTEL_EXPORTER_OTLP_ENDPOINT,
//   OTEL_BSP_MAX_EXPORT_BATCH_SIZE, OTEL_BSP_MAX_QUEUE_SIZE,
//   OTEL_BSP_SCHEDULE_DELAY, OTEL_BSP_EXPORT_TIMEOUT.

const otelExportEnabled = process.env.OTEL_EXPORT_ENABLED === "1";

const otelExportOptions: CreateServerOptions = {
    services: [benchmarkServiceRoutes],
    port: 8085,
    host: "0.0.0.0",
    tls: tlsConfig,
    interceptors: [
        ...createDefaultInterceptors({
            errorHandler: {
                logErrors: true,
                includeStackTrace: true,
            },
            serializer: true,
            validation: true,
        }),
        createLoggerInterceptor({
            level: "error",
            skipHealthCheck: true,
        }),
        createOtelInterceptor({
            filter: ({ service }) => !service.includes("grpc.health"),
        }),
    ],
};

// ============================================================================
// Start all servers
// ============================================================================

const serverCount = otelExportEnabled ? 6 : 5;
console.log(`Starting ${serverCount} server configurations:\n`);

if (tlsConfig) {
    console.log(`TLS enabled (certs from ${process.env.TLS_DIR})\n`);
}

try {
    // Initialize OTel provider eagerly when the export scenario is enabled, so
    // that the BatchSpanProcessor and exporters are set up before the first
    // request reaches the interceptor on port 8085. Without this the provider
    // would still auto-init lazily on first use, but eager init fails fast if
    // the collector endpoint is misconfigured.
    if (otelExportEnabled) {
        console.log("OTEL_EXPORT_ENABLED=1 — initializing OTLP provider");
        console.log(`  OTEL_SERVICE_NAME=${process.env.OTEL_SERVICE_NAME ?? "(unset)"}`);
        console.log(`  OTEL_TRACES_EXPORTER=${process.env.OTEL_TRACES_EXPORTER ?? "(unset)"}`);
        console.log(`  OTEL_METRICS_EXPORTER=${process.env.OTEL_METRICS_EXPORTER ?? "(unset)"}`);
        console.log(`  OTEL_EXPORTER_OTLP_ENDPOINT=${process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "(unset)"}\n`);
        initProvider({
            serviceName: process.env.OTEL_SERVICE_NAME ?? "performance-test-server",
        });
    }

    // createServer() is synchronous - creates unstarted server instances
    const serverOptions: CreateServerOptions[] = [
        baselineOptions,
        validationOptions,
        loggerOptions,
        otelOptions,
        fullChainOptions,
    ];

    if (otelExportEnabled) {
        serverOptions.push(otelExportOptions);
    }

    const servers: Server[] = serverOptions.map((opts) => createServer(opts));

    // start() is async - start all servers in parallel
    await Promise.all(servers.map((server) => server.start()));

    console.log("\nAll servers started successfully!\n");
    console.log("Port | Configuration");
    console.log("-----|-----------------------------------");
    console.log("8081 | Baseline (no interceptors)");
    console.log("8082 | Validation only");
    console.log("8083 | Logger only");
    console.log("8084 | OTel (tracing + metrics) only (no-op exporter)");
    console.log("8080 | Full chain (all interceptors, no-op exporter)");
    if (otelExportEnabled) {
        console.log("8085 | OTel export — full chain + real OTLP exporter");
    }

    console.log("\nReady for k6 benchmarks!");
    console.log("\nRun benchmarks with:");
    console.log("  k6 run k6/basic-load.js");
    console.log("  k6 run k6/interceptor-overhead.js");
    if (otelExportEnabled) {
        console.log("  k6 run k6/otel-export-overhead.js");
    }

    console.log("\nPress Ctrl+C to shutdown all servers\n");

    // ============================================================================
    // Graceful shutdown on SIGTERM/SIGINT
    // ============================================================================

    const shutdownHandler = async () => {
        console.log("\nShutting down all servers gracefully...");

        await Promise.all(servers.map((server) => server.stop()));

        if (otelExportEnabled) {
            console.log("Flushing OTel provider...");
            await shutdownProvider();
        }

        console.log("All servers stopped");
        process.exit(0);
    };

    process.on("SIGTERM", shutdownHandler);
    process.on("SIGINT", shutdownHandler);
} catch (error) {
    console.error("Failed to start servers:", error);
    process.exit(1);
}
