/**
 * Server factory — the same `buildServer()` produces a monolith or a single
 * microservice role, decided by env (see `#topology.ts`).
 *
 * What stays constant across topologies:
 *  - the same three service definitions are passed to `createServer`;
 *  - the same generated `serviceCatalog` types and routes every `ctx.call`.
 *
 * What env changes:
 *  - `enabledServices` — which of the three are mounted locally (undefined =
 *    monolith, all local). Unmounted services are reached via `remoteResolver`.
 *  - `remoteResolver` — maps a remote service `typeName` to its endpoint env var.
 *  - the EventBus role — only the payroll process subscribes to LeaveApproved.
 *
 * Persistence (Phase 1): DirectoryService is backed by Drizzle + Postgres. The
 * db is injected so tests can pass a PGlite (in-process Postgres) db; production
 * defaults to a postgres.js client over `DATABASE_URL`.
 *
 * @module server
 */

import { createServer } from "@connectum/core";
import type { Server } from "@connectum/core";
import type { EventBus } from "@connectum/events";
import type { EventBusLike } from "@connectum/core";
import { Healthcheck } from "@connectum/healthcheck";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { Reflection } from "@connectum/reflection";
import { serviceCatalog } from "#gen/catalog.gen.ts";
import { createDb } from "#db/client.ts";
import type { Db } from "#db/client.ts";
import { buildEventBus } from "#eventBus.ts";
import { createDirectoryService } from "#services/directoryService.ts";
import { payrollService } from "#services/payrollService.ts";
import { makeTimeOffService } from "#services/timeOffService.ts";
import { resolveTopology } from "#topology.ts";
import type { Topology } from "#topology.ts";

/** Options for {@link buildServer}. */
export interface BuildServerOptions {
    /** TCP port to bind (0 = random, used by tests). Defaults to `PORT` env or 5000. */
    readonly port?: number;
    /** Topology override (tests pass an explicit one); defaults to env resolution. */
    readonly topology?: Topology;
    /**
     * EventBus override. Tests inject a `MemoryAdapter`-backed bus so the
     * TimeOff publisher and the Payroll subscriber share one in-process bus.
     * Defaults to a bus built from the resolved topology.
     */
    readonly eventBus?: EventBus & EventBusLike;
    /**
     * Directory database override. Tests inject a PGlite-backed Drizzle db so the
     * e2e runs without Docker; defaults to a postgres.js client over
     * `DATABASE_URL` (see `#db/client.ts`). Injected for EVERY topology that
     * mounts the directory (including the monolith, where the TimeOff handler's
     * `ctx.call` to GetEmployee runs in-process).
     */
    readonly db?: Db;
}

/**
 * Build a Server for this process's role.
 *
 * The TimeOff service is bound to the SAME bus instance passed to the server, so
 * publish (TimeOff) and subscribe (Payroll) cross-deliver in a monolith.
 */
export function buildServer(options: BuildServerOptions = {}): Server {
    const topology = options.topology ?? resolveTopology();
    const port = options.port ?? Number(process.env.PORT ?? 5000);
    const eventBus = options.eventBus ?? buildEventBus({ localTypeNames: topology.localTypeNames });

    // Directory persistence. postgres.js connects lazily, so constructing the
    // default db is harmless even when the directory isn't mounted locally; the
    // connection is opened only when DirectoryService actually queries.
    const db = options.db ?? createDb();
    const directoryService = createDirectoryService(db);

    return createServer({
        // All three definitions are always passed; `enabledServices` decides
        // which are mounted locally vs reached via the resolver.
        services: [directoryService, makeTimeOffService(eventBus), payrollService],
        catalog: serviceCatalog,
        enabledServices: topology.enabledServices,
        remoteResolver: topology.remoteResolver,
        eventBus,
        port,
        host: "0.0.0.0",
        allowHTTP1: false,
        protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
        interceptors: createDefaultInterceptors(),
        shutdown: { autoShutdown: true, timeout: 10_000 },
    });
}
