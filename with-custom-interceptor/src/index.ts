/**
 * Custom Interceptor Example
 *
 * Demonstrates @connectum/core with custom ConnectRPC interceptors:
 * - API key authentication (SecureEcho method)
 * - Rate limiting (RateLimitedEcho method)
 * - Default interceptor chain from @connectum/interceptors
 */

import { buildServer } from "./server.ts";

console.log("Starting Custom Interceptor Example...\n");

/** The server and its interceptor chain are assembled in `server.ts`. */
const server = buildServer();

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
