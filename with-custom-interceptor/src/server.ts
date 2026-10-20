/**
 * Server factory.
 *
 * The composition root of the example: the service plus the interceptor chain.
 * `index.ts` starts it on port 5000; the e2e test builds the very same server on
 * an ephemeral port, so the test exercises the real interceptor wiring.
 *
 * @module server
 */

import { createServer } from "@connectum/core";
import type { Server } from "@connectum/core";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { apiKeyInterceptor } from "#interceptors/apiKeyInterceptor.ts";
import { rateLimitInterceptor } from "#interceptors/rateLimitInterceptor.ts";
import { echoServiceRoutes } from "#services/echoService.ts";

/**
 * Build a server with custom interceptors appended after the default chain.
 *
 * Interceptor execution order:
 * 1. Default chain (errorHandler, validation; resilience interceptors are opt-in)
 * 2. apiKeyInterceptor  — checks x-api-key for SecureEcho
 * 3. rateLimitInterceptor — rate-limits RateLimitedEcho
 *
 * @param port - TCP port to bind (0 = random, for tests).
 */
export function buildServer(port = 5000): Server {
    return createServer({
        services: [echoServiceRoutes],
        port,
        host: "0.0.0.0",
        // Plaintext HTTP/2 (h2c): the gRPC clients (grpcurl -plaintext, the
        // e2e test) speak HTTP/2. With HTTP/1.1 allowed the plaintext listener
        // is HTTP/1.1-only and rejects them.
        allowHTTP1: false,
        interceptors: [
            ...createDefaultInterceptors(),
            apiKeyInterceptor,
            rateLimitInterceptor,
        ],
        shutdown: {
            timeout: 10_000,
        },
    });
}
