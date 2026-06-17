/**
 * Server factory.
 *
 * Everything the quickstart shows is configured here: services, health checks,
 * reflection, the default interceptor chain, and graceful shutdown.
 *
 * @module server
 */

import { createServer } from "@connectum/core";
import type { Server } from "@connectum/core";
import { Healthcheck } from "@connectum/healthcheck";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { Reflection } from "@connectum/reflection";
import { greeterService } from "#services/greeterService.ts";

/**
 * Build a Connectum server hosting GreeterService.
 *
 * @param port - TCP port to bind (0 = random, for tests).
 * @param autoShutdown - install SIGTERM/SIGINT graceful-shutdown handlers.
 */
export function buildServer(port = 5000, autoShutdown = false): Server {
    return createServer({
        services: [greeterService],
        port,
        host: "0.0.0.0",
        // Plaintext HTTP/2 (h2c) — recommended for internal gRPC services.
        allowHTTP1: false,
        // gRPC health (grpc.health.v1.Health) + an HTTP /healthz endpoint.
        // gRPC server reflection (grpc.reflection.v1.ServerReflection).
        protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
        // Error handler + request validation. Resilience interceptors
        // (timeout, retry, circuit breaker, ...) are opt-in — see the docs.
        interceptors: createDefaultInterceptors(),
        shutdown: { autoShutdown, timeout: 10_000 },
    });
}
