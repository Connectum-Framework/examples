/**
 * O11y Demo Service
 *
 * Minimal Connectum service for the Coroot observability example.
 * Configured entirely via environment variables:
 *   - PORT: HTTP/2 server port (default: 5000)
 *   - OTEL_SERVICE_NAME: service identity for telemetry
 *   - OTEL_*: OpenTelemetry exporter configuration
 *
 * Both order-service and inventory-service use this same image
 * with different env vars.
 */

import type { ConnectRouter } from "@connectrpc/connect";
import { createServer } from "@connectum/core";
import type { CreateServerOptions } from "@connectum/core";
import { Healthcheck, healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { initProvider, shutdownProvider } from "@connectum/otel";
import { Reflection } from "@connectum/reflection";
import { orderServiceRoutes } from "./services/orderService.ts";
import { inventoryServiceRoutes } from "./services/inventoryService.ts";

const serviceName = process.env.OTEL_SERVICE_NAME ?? "o11y-service";
const port = Number(process.env.PORT) || 5000;

// Select routes based on service name
const serviceRoutes: Array<(router: ConnectRouter) => void> = [];
if (serviceName.includes("order")) {
    serviceRoutes.push(orderServiceRoutes);
} else if (serviceName.includes("inventory")) {
    serviceRoutes.push(inventoryServiceRoutes);
}

// ── Initialize OpenTelemetry ────────────────────────────────────────────────
// Must be called before server start to register exporters.
// Reads OTEL_TRACES_EXPORTER, OTEL_METRICS_EXPORTER, OTEL_LOGS_EXPORTER,
// and OTEL_EXPORTER_OTLP_ENDPOINT from environment.
initProvider({ serviceName });

console.log(`Starting ${serviceName} on port ${port}...`);

// ── Server configuration ────────────────────────────────────────────────────
const options: CreateServerOptions = {
    services: serviceRoutes,

    port,
    host: "0.0.0.0",

    protocols: [
        Healthcheck({ httpEnabled: true }),
        Reflection(),
    ],

    interceptors: createDefaultInterceptors(),

    shutdown: {
        timeout: 10_000,
    },
};

const server = createServer(options);

// ── Lifecycle hooks ─────────────────────────────────────────────────────────
server.on("start", () => {
    console.log(`[${serviceName}] Server starting...`);
});

server.on("ready", () => {
    // Register service in healthcheck manager after Healthcheck protocol plugin
    // has initialized. Without registered services, areAllHealthy() returns false.
    healthcheckManager.initialize([serviceName]);
    healthcheckManager.update(ServingStatus.SERVING);
    console.log(`[${serviceName}] Ready on :${server.address?.port}`);
    console.log(`[${serviceName}] Health: http://localhost:${server.address?.port}/healthz`);
});

server.on("stop", async () => {
    console.log(`[${serviceName}] Shutting down OTEL provider...`);
    await shutdownProvider();
    console.log(`[${serviceName}] Stopped`);
});

server.on("error", (err) => {
    console.error(`[${serviceName}] Error:`, err);
});

// ── Start ───────────────────────────────────────────────────────────────────
await server.start();
