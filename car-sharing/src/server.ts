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

import type { Interceptor } from "@connectrpc/connect";
import type { Server } from "@connectum/core";
import { createServer } from "@connectum/core";
import { Healthcheck } from "@connectum/healthcheck";
import { createDefaultInterceptors, createErrorHandlerInterceptor } from "@connectum/interceptors";
import { Reflection } from "@connectum/reflection";
import { buildAuthInterceptors } from "#auth.ts";
import type { Db } from "#db/client.ts";
import { createDb } from "#db/client.ts";
import { serviceCatalog } from "#gen/catalog.gen.ts";
import { buildOtelInterceptor } from "#observability.ts";
import { billingService } from "#services/billingService.ts";
import { createFleetService } from "#services/fleetService.ts";
import type { TripWorkflowClient } from "#services/tripService.ts";
import { createTripService } from "#services/tripService.ts";
import { TEMPORAL_TASK_QUEUE } from "#temporal/config.ts";
import { createWorkflowClient } from "#temporal/workflowClient.ts";
import type { Topology } from "#topology.ts";
import { resolveTopology, TYPE_NAMES } from "#topology.ts";

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
    /**
     * Fleet database override. Tests inject a PGlite-backed Drizzle db so the
     * e2e runs without Docker; defaults to a postgres.js client over
     * `DATABASE_URL` (see `#db/client.ts`). Injected for EVERY topology that
     * mounts the fleet (including the monolith, where the trip handler's
     * `ctx.call` to FleetService runs in-process).
     */
    readonly db?: Db;
    /**
     * Temporal client override for TripService.
     *
     *  - `undefined` (default): when the role hosts TripService, a real LAZY
     *    `@temporalio/client` `WorkflowClient` is built (no socket until the
     *    first start/query — so the server starts and the pre-check e2e runs
     *    without a live Temporal). When the role does NOT host TripService, no
     *    client is built.
     *  - a value: injected verbatim (tests pass a stub; pass `null` to force the
     *    "Temporal not configured" path even when TripService is mounted).
     */
    readonly workflowClient?: TripWorkflowClient | null;
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

    // Fleet persistence. postgres.js connects lazily, so constructing the
    // default db is harmless even when the fleet isn't mounted locally; the
    // connection is opened only when FleetService actually queries.
    const db = options.db ?? createDb();
    const fleetService = createFleetService(db);

    // Temporal client for the trip saga. Built only when this role hosts
    // TripService and no override was given. The default client is LAZY (no
    // socket until the first start/query), so the server starts and the
    // pre-check e2e runs without a live Temporal server. An explicit `null`
    // forces the "Temporal not configured" path; an explicit value (a test
    // stub) is used verbatim.
    const hostsTrips = topology.localTypeNames.includes(TYPE_NAMES.trips);
    let workflowClient: TripWorkflowClient | undefined;
    if (options.workflowClient !== undefined) {
        workflowClient = options.workflowClient ?? undefined;
    } else if (hostsTrips) {
        // The concrete WorkflowClient structurally satisfies the narrow
        // TripWorkflowClient port (it has start/getHandle/query/describe); the
        // cast adapts its richer generic overloads to the port the handler uses.
        workflowClient = createWorkflowClient() as unknown as TripWorkflowClient;
    }
    const tripService = createTripService({ workflowClient, taskQueue: TEMPORAL_TASK_QUEUE });

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
