/**
 * Server factory — the same `buildServer()` produces a monolith or a single
 * microservice role, decided by env (see `#topology.ts`).
 *
 * What stays constant across topologies:
 *  - the same three service definitions are passed to `createServer`;
 *  - the same generated `serviceCatalog` types and routes every `ctx.call`;
 *  - the same interceptor chain in the recommended fixed order (errorHandler →
 *    end-user JWT auth → service-token auth → proto authz → OTel →
 *    validation). The chain is uniform; per-method behaviour comes from proto
 *    annotations (fleet/billing and RecordTrip/EndTrip are `internal`,
 *    StartTrip/GetTrip require an end-user JWT).
 *
 * What env changes:
 *  - `enabledServices` — which of the three are mounted locally (undefined =
 *    monolith, all local). Unmounted services are reached via the remote
 *    resolver, which maps a remote service `typeName` to its endpoint env var.
 *  - the trusted internal token issuers (`INTERNAL_ISSUER_*_JWKS`).
 *  - the OTel interceptor — present only when an OTLP endpoint is configured.
 *
 * A role that hosts TripService must be given the trips signer: StartTrip's
 * pre-check calls FleetService, an internal service, and that call is signed
 * on BOTH paths — `outgoingInterceptors` for the in-process transport
 * (monolith) and the remote resolver's transport for the network (split).
 *
 * @module server
 */

import type { Interceptor } from "@connectrpc/connect";
import type { Server } from "@connectum/core";
import { createServer, perServiceEnvResolver } from "@connectum/core";
import { Healthcheck } from "@connectum/healthcheck";
import { createDefaultInterceptors, createErrorHandlerInterceptor } from "@connectum/interceptors";
import { Reflection } from "@connectum/reflection";
import { buildAuthInterceptors, JWT_AUDIENCE, JWT_ISSUER } from "#auth.ts";
import type { Db } from "#db/client.ts";
import { createDb } from "#db/client.ts";
import { serviceCatalog } from "#gen/catalog.gen.ts";
import type { InternalIssuers, InternalSigner } from "#internalAuth.ts";
import { createSignedTransport, internalIssuersFromEnv } from "#internalAuth.ts";
import { buildOtelInterceptor } from "#observability.ts";
import { billingService } from "#services/billingService.ts";
import { createFleetService } from "#services/fleetService.ts";
import type { TripWorkflowClient } from "#services/tripService.ts";
import { createTripService } from "#services/tripService.ts";
import { TEMPORAL_TASK_QUEUE } from "#temporal/config.ts";
import { createWorkflowClient } from "#temporal/workflowClient.ts";
import type { Topology } from "#topology.ts";
import { ENDPOINT_ENV, resolveTopology, TYPE_NAMES } from "#topology.ts";

/**
 * Default JWKS endpoint when none is configured: Ory Oathkeeper's PUBLIC
 * signing-key API (compose service name + API port). Production / k8s override
 * with `OATHKEEPER_JWKS_URI`; the e2e injects an in-process JWKS server URL.
 */
const DEFAULT_OATHKEEPER_JWKS_URI = "http://oathkeeper:4456/.well-known/jwks.json";

/** Options for {@link buildServer}. */
export interface BuildServerOptions {
    /** TCP port to bind (0 = random, used by tests). Defaults to `PORT` env or 5000. */
    readonly port?: number;
    /** Topology override (tests pass an explicit one); defaults to env resolution. */
    readonly topology?: Topology;
    /**
     * JWKS endpoint serving Oathkeeper's RS256 public keys, used by the JWT
     * interceptor's `createRemoteJWKSet` branch. Defaults to
     * `OATHKEEPER_JWKS_URI` env, then the compose Oathkeeper API URL. Tests inject
     * an in-process JWKS server so the production validation branch is exercised.
     */
    readonly jwksUri?: string;
    /** JWT issuer (`iss`) to require. Defaults to `JWT_ISSUER` env, then {@link JWT_ISSUER}. */
    readonly issuer?: string;
    /** JWT audience (`aud`) to require. Defaults to `JWT_AUDIENCE` env, then {@link JWT_AUDIENCE}. */
    readonly audience?: string;
    /**
     * Serve the EDGE over the Connect protocol on HTTP/1.1 (`true`) vs gRPC over
     * plaintext h2c (`false`, default). On a plaintext listener these are MUTUALLY
     * EXCLUSIVE in `@connectum/core`: `allowHTTP1: true` → `http.createServer`
     * (HTTP/1.1 only, no h2c), `allowHTTP1: false` → `http2.createServer` (h2c).
     *
     * Default `false` keeps every gRPC consumer working unchanged — the e2e/fleet
     * gRPC clients, internal `ctx.call` hops, and k8s/istio (which terminate gRPC
     * at Envoy). ONLY the compose `ory` profile sets `ALLOW_HTTP1=true` on the
     * trips role, because the Ory Oathkeeper standalone reverse proxy proxies
     * plain HTTP, not trailer-aware gRPC, for a Node upstream. The edge service
     * (TripService) is all-unary, so HTTP/1.1 is sufficient there; the monolith
     * (which also mounts streaming `ListVehicles`) keeps the h2c default.
     */
    readonly allowHTTP1?: boolean;
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
    /**
     * The trips service identity, used to sign this role's outgoing internal
     * calls (StartTrip's pre-check to FleetService). REQUIRED when the role
     * hosts TripService — without it every StartTrip would fail its pre-check
     * as Unauthenticated, so {@link buildServer} refuses to build instead.
     * The caller owns the signer's JWKS endpoint (see `src/index.ts`).
     */
    readonly internalSigner?: InternalSigner;
    /**
     * Services whose tokens this role accepts on internal methods. Defaults to
     * `internalIssuersFromEnv()` (`INTERNAL_ISSUER_*_JWKS`); tests inject the
     * JWKS URLs of their in-process signers.
     */
    readonly internalIssuers?: InternalIssuers;
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
    const hostsTrips = topology.localTypeNames.includes(TYPE_NAMES.trips);

    // Service-to-service identity. The trips handler's pre-check is the only
    // ctx.call in the app, so only a role hosting TripService signs. Checked
    // first: a missing signer is a wiring mistake in the caller, and reporting
    // it beats failing on some unrelated setting further down.
    const signer = options.internalSigner;
    if (hostsTrips && signer === undefined) {
        throw new Error(
            'buildServer: this role hosts trips.v1.TripService, whose StartTrip calls the internal FleetService — pass `internalSigner` (createInternalSigner("trips")) so that call carries a service token.',
        );
    }
    const internalIssuers = options.internalIssuers ?? internalIssuersFromEnv();
    // Remote peers are dialled with a transport that signs every request; the
    // in-process transport gets the same interceptor via outgoingInterceptors.
    // Roles without a signer make no internal calls, so plain gRPC is enough.
    const remoteResolver = perServiceEnvResolver(ENDPOINT_ENV, signer ? { createTransport: (baseUrl) => createSignedTransport(baseUrl, signer) } : undefined);

    // Phase 4 IdP-consumer identity inputs. The trips gateway never holds a
    // signing secret; it validates RS256 tokens against Oathkeeper's published
    // JWKS, and trusts only the configured `iss`/`aud`. `JWT_ISSUER` is the
    // single source of truth shared with the mutator and the test mint.
    const jwksUri = options.jwksUri ?? process.env.OATHKEEPER_JWKS_URI ?? DEFAULT_OATHKEEPER_JWKS_URI;
    const issuer = options.issuer ?? process.env.JWT_ISSUER ?? JWT_ISSUER;
    const audience = options.audience ?? process.env.JWT_AUDIENCE ?? JWT_AUDIENCE;

    // Edge transport posture. Default h2c (gRPC); the compose `ory` profile sets
    // ALLOW_HTTP1=true on trips so Oathkeeper's HTTP reverse proxy can front it.
    const allowHTTP1 = options.allowHTTP1 ?? (process.env.ALLOW_HTTP1 === "true" || process.env.ALLOW_HTTP1 === "1");

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
        // Fixed chain order: errorHandler first, then authn (end-user JWT and
        // service token) and authz immediately after it (so unauthenticated
        // requests are rejected before validation), then OTel — placed after
        // authz so getAuthContext() is populated for enduser span attributes —
        // then the default validation chain.
        createErrorHandlerInterceptor(),
        ...buildAuthInterceptors({ jwksUri, issuer, audience, internalIssuers }),
        ...(otelInterceptor ? [otelInterceptor] : []),
        ...createDefaultInterceptors({ errorHandler: false }),
    ];

    return createServer({
        services: [fleetService, tripService, billingService],
        catalog: serviceCatalog,
        enabledServices: topology.enabledServices,
        remoteResolver,
        // Applies only to the in-process transport (a local ctx.call in the
        // monolith); network calls are signed by the resolver's transport.
        outgoingInterceptors: signer ? [signer.interceptor] : [],
        port,
        host: "0.0.0.0",
        // Phase 4 edge posture, env-gated (default h2c/gRPC). On a plaintext
        // listener `@connectum/core` serves EITHER h2c (allowHTTP1:false) OR
        // HTTP/1.1 (allowHTTP1:true) — not both. The compose `ory` profile sets
        // ALLOW_HTTP1=true on the trips role so Ory Oathkeeper's HTTP reverse
        // proxy (which does not carry trailer-aware gRPC for a Node upstream) can
        // front the all-unary TripService over Connect/HTTP1. Everything else —
        // the e2e/fleet gRPC clients, internal `ctx.call` hops, and k8s/istio
        // (Envoy terminates gRPC; Oathkeeper is an ext_authz decision service) —
        // keeps the gRPC default unchanged.
        allowHTTP1,
        protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
        interceptors,
        shutdown: { autoShutdown: true, timeout: 10_000 },
    });
}
