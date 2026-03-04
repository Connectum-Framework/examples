/**
 * Custom Interceptor Example
 *
 * Demonstrates @connectum/core with custom ConnectRPC interceptors:
 * - API key authentication (SecureEcho method)
 * - Rate limiting (RateLimitedEcho method)
 * - Default interceptor chain from @connectum/interceptors
 */

import { createServer } from "@connectum/core";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { apiKeyInterceptor } from "./interceptors/apiKeyInterceptor.ts";
import { rateLimitInterceptor } from "./interceptors/rateLimitInterceptor.ts";
import { echoServiceRoutes } from "./services/echoService.ts";

console.log("Starting Custom Interceptor Example...\n");

/**
 * Create server with custom interceptors appended after the default chain.
 *
 * Interceptor execution order:
 * 1. Default chain (errorHandler, timeout, bulkhead, circuitBreaker, retry, fallback, serializer)
 * 2. apiKeyInterceptor  — checks x-api-key for SecureEcho
 * 3. rateLimitInterceptor — rate-limits RateLimitedEcho
 */
const server = createServer({
    services: [echoServiceRoutes],
    port: 5000,
    host: "0.0.0.0",
    interceptors: [
        ...createDefaultInterceptors(),
        apiKeyInterceptor,
        rateLimitInterceptor,
    ],
    shutdown: {
        timeout: 10_000,
    },
});

/**
 * Lifecycle hooks
 */
server.on("start", () => {
    console.log("Server is starting...");
});

server.on("ready", () => {
    const addr = server.address;
    console.log(`\nServer ready on ${addr?.address}:${addr?.port}`);

    console.log("\nAvailable services:");
    console.log("  - echo.v1.EchoService/Echo              (no protection)");
    console.log("  - echo.v1.EchoService/SecureEcho        (API key required)");
    console.log("  - echo.v1.EchoService/RateLimitedEcho   (rate limited)");

    console.log("\nTest commands:");
    console.log(`  # Echo (no protection)`);
    console.log(`  grpcurl -plaintext -d '{"message": "Hello"}' localhost:${addr?.port} echo.v1.EchoService/Echo`);
    console.log(`\n  # SecureEcho (requires API key)`);
    console.log(`  grpcurl -plaintext -H 'x-api-key: test-api-key-123' -d '{"message": "Secret"}' localhost:${addr?.port} echo.v1.EchoService/SecureEcho`);
    console.log(`\n  # SecureEcho (will fail — no API key)`);
    console.log(`  grpcurl -plaintext -d '{"message": "Secret"}' localhost:${addr?.port} echo.v1.EchoService/SecureEcho`);
    console.log(`\n  # RateLimitedEcho (5 requests per 60s window)`);
    console.log(`  grpcurl -plaintext -d '{"message": "Rate me"}' localhost:${addr?.port} echo.v1.EchoService/RateLimitedEcho`);

    console.log("\nPress Ctrl+C to shutdown gracefully\n");
});

server.on("stop", () => {
    console.log("Server stopped");
});

server.on("error", (err) => {
    console.error("Server error:", err);
});

/**
 * Start the server
 */
await server.start();
