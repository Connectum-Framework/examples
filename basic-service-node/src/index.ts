/**
 * Basic Service Example
 *
 * Demonstrates @connectum/core setup with new explicit lifecycle API:
 * - Simple Greeter service
 * - Health checks (gRPC + HTTP) via protocol plugin
 * - Server reflection via protocol plugin
 * - Default interceptors (explicit via @connectum/interceptors)
 * - Lifecycle hooks
 * - Graceful shutdown
 */

import { createServer } from "@connectum/core";
import type { CreateServerOptions } from "@connectum/core";
import { Healthcheck, healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { Reflection } from "@connectum/reflection";
import { greeterServiceRoutes } from "./services/greeterService.ts";

console.log("🚀 Starting Basic Service Example...\n");

/**
 * Configure server options
 *
 * Interceptors are passed explicitly — core has no built-in interceptors.
 * Use createDefaultInterceptors() from @connectum/interceptors for the
 * default chain (error handler + validation; resilience interceptors
 * such as timeout, bulkhead, circuitBreaker, retry are opt-in).
 */
const options: CreateServerOptions = {
    // Register services
    services: [greeterServiceRoutes],

    // Server configuration
    port: 5000,
    host: "0.0.0.0",

    // Protocol registrations (healthcheck + reflection)
    protocols: [Healthcheck({ httpEnabled: true }), Reflection()],

    // Interceptors (explicit)
    interceptors: createDefaultInterceptors(),

    // Graceful shutdown configuration
    shutdown: {
        timeout: 10_000, // 10 seconds
    },
};

/**
 * Create server (not started yet)
 */
const server = createServer(options);

/**
 * Lifecycle hooks
 */
server.on("start", () => {
    console.log("📡 Server is starting...");
});

server.on("ready", () => {
    const addr = server.address;
    console.log(`\n✅ Server ready on ${addr?.address}:${addr?.port}`);
    console.log("\n📡 Available services:");
    console.log("  - greeter.v1.GreeterService");
    console.log("  - grpc.health.v1.Health");
    console.log("  - grpc.reflection.v1.ServerReflection");

    console.log("\n🧪 Test with grpcurl:");
    console.log(`  grpcurl -plaintext localhost:${server.address?.port} list`);
    console.log(`  grpcurl -plaintext -d '{"name": "Alice"}' localhost:${server.address?.port} greeter.v1.GreeterService/SayHello`);
    console.log(`  curl http://localhost:${server.address?.port}/healthz`);

    console.log("\n🛑 Press Ctrl+C to shutdown gracefully\n");

    // Set service as healthy after server is ready
    healthcheckManager.update(ServingStatus.SERVING, "greeter.v1.GreeterService");
});

server.on("stop", () => {
    console.log("✅ Server stopped");
});

server.on("error", (err) => {
    console.error("❌ Server error:", err);
});

/**
 * Start the server (explicit lifecycle)
 */
await server.start();
