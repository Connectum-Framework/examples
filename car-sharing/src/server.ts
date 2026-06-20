/**
 * Server factory — the same `buildServer()` produces a monolith or a single
 * microservice role, decided by env (see `#topology.ts`).
 *
 * What stays constant across topologies:
 *  - the same three service definitions are passed to `createServer`;
 *  - the same generated `serviceCatalog` types and routes every `ctx.call`;
 *  - the same gateway interceptor chain in ADR-024 order (errorHandler → JWT
 *    auth → proto authz → OTel → validation). The chain is uniform; per-method
 *    behaviour comes from proto annotations (fleet/billing are `public`,
 *    TripService requires auth).
 *
 * What env changes:
 *  - `enabledServices` — which of the three are mounted locally (undefined =
 *    monolith, all local). Unmounted services are reached via `remoteResolver`.
 *  - `remoteResolver` — maps a remote service `typeName` to its endpoint env var.
 *  - the OTel interceptor — present only when an OTLP endpoint is configured.
 *
 * @module server
 */

import { createServer } from "@connectum/core";
import type { Server } from "@connectum/core";
import type { Interceptor } from "@connectrpc/connect";
import { Healthcheck } from "@connectum/healthcheck";
import { createDefaultInterceptors, createErrorHandlerInterceptor } from "@connectum/interceptors";
import { Reflection } from "@connectum/reflection";
import { serviceCatalog } from "#gen/catalog.gen.ts";
import { buildAuthInterceptors } from "#auth.ts";
import { buildOtelInterceptor } from "#observability.ts";
import { billingService } from "#services/billingService.ts";
import { fleetService } from "#services/fleetService.ts";
import { tripService } from "#services/tripService.ts";
import { resolveTopology } from "#topology.ts";
import type { Topology } from "#topology.ts";

/** Default dev/test JWT secret. Production overrides with `JWT_SECRET`. */
const DEV_JWT_SECRET = "connectum-test-secret-do-not-use-in-production";

/** Options for {@link buildServer}. */
export interface BuildServerOptions {
    /** TCP port to bind (0 = random, used by tests). Defaults to `PORT` env or 5000. */
    readonly port?: number;
    /** Topology override (tests pass an explicit one); defaults to env resolution. */
    readonly topology?: Topology;
    /** JWT secret override (tests inject the shared test secret). Defaults to `JWT_SECRET` env. */
    readonly jwtSecret?: string;
}

/**
 * Build a Server for this process's role.
 *
 * All three definitions are always passed; `enabledServices` decides which are
 * mounted locally vs reached via the resolver. The interceptor chain is the
 * same for every role.
 */
export function buildServer(options: BuildServerOptions = {}): Server {
    const topology = options.topology ?? resolveTopology();
    const port = options.port ?? Number(process.env.PORT ?? 5000);
    const jwtSecret = options.jwtSecret ?? process.env.JWT_SECRET ?? DEV_JWT_SECRET;

    const otelInterceptor = buildOtelInterceptor();
    const interceptors: Interceptor[] = [
        // ADR-024 chain order: errorHandler first, then auth/authz immediately
        // after it (so unauthenticated requests are rejected before validation),
        // then OTel — placed after authz so getAuthContext() is populated for
        // enduser span attributes — then the default validation chain.
        createErrorHandlerInterceptor(),
        ...buildAuthInterceptors({ secret: jwtSecret }),
        ...(otelInterceptor ? [otelInterceptor] : []),
        ...createDefaultInterceptors({ errorHandler: false }),
    ];

    return createServer({
        services: [fleetService, tripService, billingService],
        catalog: serviceCatalog,
        enabledServices: topology.enabledServices,
        remoteResolver: topology.remoteResolver,
        port,
        host: "0.0.0.0",
        allowHTTP1: false,
        protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
        interceptors,
        shutdown: { autoShutdown: true, timeout: 10_000 },
    });
}
