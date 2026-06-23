/**
 * E2E tests — MONOLITH mode, in-process, no cluster, no live Temporal.
 *
 * The whole car-sharing app runs in ONE process; every service is mounted
 * locally. Phase 2 changed StartTrip from an inline `ctx.call` chain to a
 * synchronous availability PRE-CHECK followed by STARTING a durable Temporal
 * workflow. That reshapes what the server-only e2e can assert:
 *
 *  - The PRE-CHECK error paths still run WITHOUT a live Temporal, because they
 *    fail BEFORE the workflow is started: an unavailable vehicle →
 *    `Code.FailedPrecondition` (the trip handler's guard), an unknown vehicle →
 *    `Code.NotFound` (propagated from FleetService's `ctx.call`). A STUB
 *    Temporal client is injected so the success path can be asserted too — it
 *    records the `start` call instead of contacting a real server, proving the
 *    pre-check ran first and StartTrip returns `{ trip:{ id, status:STARTED },
 *    workflow_id }` with `workflow_id === trip.id`.
 *  - The gateway auth (Phase 4 — Ory as the IdP): trips is a thin IdP CONSUMER.
 *    It validates an RS256 JWT (minted at the edge by Ory Oathkeeper from a Kratos
 *    session) against Oathkeeper's published JWKS. The dockerless suite does NOT
 *    run Ory; instead it simulates the mutator with a test RSA keypair + an
 *    in-process JWKS server (`tests/helpers/jwks.ts`) and exercises the SAME
 *    production validation branch (`createJwtAuthInterceptor({ jwksUri })` →
 *    `jose.createRemoteJWKSet`). A StartTrip/GetTrip with NO / an INVALID /
 *    wrong-issuer / wrong-audience / EXPIRED token is rejected as
 *    `Code.Unauthenticated` by the JWT interceptor (before any pre-check).
 *  - FleetService is `public`: a direct in-process call needs no token.
 *
 * The happy-path billing side effects (openTab → addCharge → settle and
 * compensation) are now owned by the Temporal saga and are asserted in the
 * workflow test (orchestration order) and the activity test (real
 * tabCount/charge + idempotency) — NOT here, since they no longer run
 * synchronously inside StartTrip.
 *
 * Edge-protocol note: the dockerless suite talks DIRECT gRPC to trips (no
 * Oathkeeper hop, no Connect/HTTP1). The one runtime change, `allowHTTP1: true`,
 * is additive (trips still serves HTTP/2 gRPC) and so has no dedicated assertion
 * here; the Connect-over-HTTP/1.1 edge is validated only by the compose `ory`
 * flow (README), the project's config-only convention (like `k8s/`/`istio/`).
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { QueryNotRegisteredError } from "@temporalio/client";
import { JWT_AUDIENCE, JWT_ISSUER } from "#auth.ts";
import { BillingService } from "#gen/billing/v1/billing_pb.ts";
import { FleetService } from "#gen/fleet/v1/fleet_pb.ts";
import { GetTripRequestSchema, StartTripRequestSchema, TripService } from "#gen/trips/v1/trips_pb.ts";
import { buildServer } from "#server.ts";
import type { TripWorkflowClient, TripWorkflowHandle } from "#services/tripService.ts";
import { resolveTopology } from "#topology.ts";
import { makeTestDb } from "../helpers/db.ts";
import { generateRsaTestKeypair, type JwksServer, mintOathkeeperJwt, startJwksServer } from "../helpers/jwks.ts";

/** A recorded `start` call (workflow type + the workflow id used). */
interface StartCall {
    workflowType: string;
    workflowId: string;
}

/** How a stub handle answers GetTrip: a live query result, or a closed describe(). */
interface StubHandleBehaviour {
    /** Status the live Query returns; if `undefined`, the Query throws. */
    readonly queryStatus?: string;
    /** Workflow status name returned by describe() when the Query is rejected. */
    readonly describeStatusName?: string;
    /**
     * When the Query throws (`queryStatus` undefined), what kind of failure:
     * `"closed"` (default) → a `QueryNotRegisteredError`, which the handler
     * treats as "run closed/gone" and falls back to describe(); `"transient"` →
     * a generic error, which the handler must surface as `Unavailable`.
     */
    readonly queryError?: "closed" | "transient";
}

/**
 * A stub Temporal client that records `start` calls and answers `getHandle`
 * queries from `handleBehaviour` — so both StartTrip AND GetTrip run with NO
 * live Temporal. The query/describe SHAPE the real client exposes is reproduced
 * so the handler's mapping (live Query → status, rejected Query → describe()
 * fallback) is validated at the RPC boundary.
 */
function makeStubWorkflowClient(starts: StartCall[], handleBehaviour: () => StubHandleBehaviour): TripWorkflowClient {
    return {
        async start(workflowType, options) {
            starts.push({ workflowType, workflowId: options.workflowId });
            return { workflowId: options.workflowId };
        },
        getHandle(): TripWorkflowHandle {
            const behaviour = handleBehaviour();
            return {
                async query<Ret>(): Promise<Ret> {
                    if (behaviour.queryStatus === undefined) {
                        if (behaviour.queryError === "transient") {
                            // A generic/infra failure — NOT a closed-run signal.
                            throw new Error("temporal frontend unavailable");
                        }
                        // Closed/gone run: its query handler is not registered.
                        // (code 3 = INVALID_ARGUMENT; the handler keys off the type.)
                        throw new QueryNotRegisteredError("query handler not registered on a closed run", 3);
                    }
                    return behaviour.queryStatus as Ret;
                },
                async describe() {
                    return { status: { name: behaviour.describeStatusName ?? "RUNNING" } };
                },
            };
        },
    };
}

describe("E2E: car-sharing monolith (in-process gateway, no cluster, stub Temporal)", () => {
    let server: Server;
    let jwks: JwksServer;
    let trips: Client<typeof TripService>;
    let userToken: string;
    // The RSA signing key behind the published JWKS — used to mint every token
    // (valid and negative) so they share the JWKS `kid` and no refetch is needed.
    let mint: (options: { sub: string; name?: string; roles?: readonly string[]; issuer?: string; audience?: string; ttl?: string | number }) => Promise<string>;
    const starts: StartCall[] = [];
    // Mutated per GetTrip test to drive the stub handle's query/describe answers.
    let handleBehaviour: StubHandleBehaviour = { queryStatus: "STARTED" };

    before(async () => {
        // Force monolith topology so fleet, trips and billing are all mounted
        // locally and ctx.call routes in-process. Phase 4: generate a throwaway
        // RS256 keypair, publish its public JWK over an in-process JWKS server,
        // and point the gateway's JWT interceptor at it via `jwksUri` — the SAME
        // production validation branch (`createRemoteJWKSet`) Oathkeeper feeds in
        // compose. Inject a PGlite-backed Drizzle db so FleetService persists
        // without Docker, and a STUB Temporal client so StartTrip's success path
        // AND GetTrip run without a live Temporal.
        const topology = resolveTopology("*");
        const db = await makeTestDb();
        const keypair = await generateRsaTestKeypair();
        // Bind the JWKS server BEFORE buildServer so the first key fetch succeeds.
        jwks = await startJwksServer(keypair.publicJwk);
        // Helper bound to this keypair; defaults issuer/audience to the gateway's
        // expected values (JWT_ISSUER is the single source of truth, shared with
        // the Oathkeeper mutator and the compose env).
        mint = ({ sub, name, roles, issuer = JWT_ISSUER, audience = JWT_AUDIENCE, ttl }) =>
            mintOathkeeperJwt(keypair.privateKey, { sub, name, roles, issuer, audience, ttl });

        server = buildServer({ port: 0, topology, jwksUri: jwks.url, db, workflowClient: makeStubWorkflowClient(starts, () => handleBehaviour) });
        await server.start();
        const port = server.address?.port ?? 0;

        userToken = await mint({ sub: "user-42", name: "Dana", roles: ["rider"] });
        trips = createClient(TripService, createGrpcTransport({ baseUrl: `http://localhost:${port}` }));
    });

    after(async () => {
        if (server.state === "running") await server.stop();
        await jwks.close();
    });

    it("mounts all three services from the generated catalog (monolith)", () => {
        assert.equal(server.hasService(FleetService), true);
        assert.equal(server.hasService(TripService), true);
        assert.equal(server.hasService(BillingService), true);
    });

    it("StartTrip (authenticated): pre-checks fleet availability then STARTS the workflow", async () => {
        const before = starts.length;

        const res = await trips.startTrip(create(StartTripRequestSchema, { userId: "user-42", vehicleId: "v-001" }), {
            headers: { Authorization: `Bearer ${userToken}` },
        });

        // The synchronous response carries the trip id, the STARTED status, and
        // the workflow id (== the trip id).
        assert.equal(res.trip?.status, "STARTED");
        assert.ok(res.trip?.id.startsWith("trip-"));
        assert.equal(res.workflowId, res.trip?.id);

        // Exactly one workflow was started, of the right type, keyed by trip id.
        assert.equal(starts.length, before + 1);
        const started = starts[starts.length - 1];
        assert.equal(started?.workflowType, "TripWorkflow");
        assert.equal(started?.workflowId, res.trip?.id);
    });

    it("GetTrip (authenticated): reads LIVE status from the workflow Query", async () => {
        handleBehaviour = { queryStatus: "ENDED" };
        const res = await trips.getTrip(create(GetTripRequestSchema, { tripId: "trip-live" }), {
            headers: { Authorization: `Bearer ${userToken}` },
        });
        assert.equal(res.trip?.id, "trip-live");
        // The handler maps the live Query result straight through.
        assert.equal(res.trip?.status, "ENDED");
    });

    it("GetTrip falls back to a terminal status via describe() when the workflow has CLOSED", async () => {
        // queryStatus undefined → the stub Query throws a QueryNotRegisteredError
        // (the run is closed/gone), which the handler treats as "fall back to
        // describe()": COMPLETED → SETTLED.
        handleBehaviour = { describeStatusName: "COMPLETED" };
        const settled = await trips.getTrip(create(GetTripRequestSchema, { tripId: "trip-done" }), {
            headers: { Authorization: `Bearer ${userToken}` },
        });
        assert.equal(settled.trip?.status, "SETTLED");

        // A failed/cancelled closed run maps to CANCELLED.
        handleBehaviour = { describeStatusName: "FAILED" };
        const cancelled = await trips.getTrip(create(GetTripRequestSchema, { tripId: "trip-failed" }), {
            headers: { Authorization: `Bearer ${userToken}` },
        });
        assert.equal(cancelled.trip?.status, "CANCELLED");
    });

    it("GetTrip surfaces Unavailable (NOT a terminal status) when the live Query fails transiently", async () => {
        // Regression for the blanket catch that mapped ANY query error to a
        // terminal status: a transient/infra failure must surface as Unavailable,
        // never be silently reported as a SETTLED/CANCELLED trip.
        handleBehaviour = { queryError: "transient" };
        await assert.rejects(
            trips.getTrip(create(GetTripRequestSchema, { tripId: "trip-flaky" }), {
                headers: { Authorization: `Bearer ${userToken}` },
            }),
            (err: unknown) => err instanceof ConnectError && err.code === Code.Unavailable,
        );
    });

    it("gateway auth: GetTrip with NO token is rejected as Unauthenticated", async () => {
        await assert.rejects(
            trips.getTrip(create(GetTripRequestSchema, { tripId: "trip-live" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.Unauthenticated,
        );
    });

    it("StartTrip with an UNAVAILABLE vehicle is FailedPrecondition BEFORE the workflow starts", async () => {
        const before = starts.length;
        await assert.rejects(
            // v-003 is maintenance in the seed.
            trips.startTrip(create(StartTripRequestSchema, { userId: "user-42", vehicleId: "v-003" }), {
                headers: { Authorization: `Bearer ${userToken}` },
            }),
            (err: unknown) => err instanceof ConnectError && err.code === Code.FailedPrecondition,
        );
        // The pre-check fired before the workflow start — no workflow started.
        assert.equal(starts.length, before);
    });

    it("StartTrip with an UNKNOWN vehicle surfaces Code.NotFound BEFORE the workflow starts", async () => {
        // The fleet's NotFound travels back through TripService's pre-check
        // ctx.call and out to the external gRPC client.
        const before = starts.length;
        await assert.rejects(
            trips.startTrip(create(StartTripRequestSchema, { userId: "user-42", vehicleId: "ghost" }), {
                headers: { Authorization: `Bearer ${userToken}` },
            }),
            (err: unknown) => err instanceof ConnectError && err.code === Code.NotFound,
        );
        assert.equal(starts.length, before);
    });

    it("gateway auth: StartTrip with NO token is rejected as Unauthenticated", async () => {
        const before = starts.length;
        await assert.rejects(
            trips.startTrip(create(StartTripRequestSchema, { userId: "user-42", vehicleId: "v-001" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.Unauthenticated,
        );
        // No handler ran, so no workflow started.
        assert.equal(starts.length, before);
    });

    it("gateway auth: StartTrip with an INVALID token is rejected as Unauthenticated", async () => {
        const before = starts.length;
        await assert.rejects(
            trips.startTrip(create(StartTripRequestSchema, { userId: "user-42", vehicleId: "v-001" }), {
                headers: { Authorization: "Bearer not.a.jwt" },
            }),
            (err: unknown) => err instanceof ConnectError && err.code === Code.Unauthenticated,
        );
        assert.equal(starts.length, before);
    });

    // Phase 4 trust-boundary negatives (contract conformance): a SIGNATURE-VALID
    // token (same RSA key + kid, so it passes JWKS key selection) is still
    // rejected when its `iss`/`aud`/`exp` don't match what the gateway requires.
    // These prove the issuer/audience/expiry CLAIM checks, not just the signature
    // — the "INVALID token" case above only exercises parse/signature failure.
    it("gateway auth: StartTrip with a WRONG ISSUER token is rejected as Unauthenticated", async () => {
        const before = starts.length;
        const wrongIssuer = await mint({ sub: "user-42", name: "Dana", issuer: "http://evil-idp.example/" });
        await assert.rejects(
            trips.startTrip(create(StartTripRequestSchema, { userId: "user-42", vehicleId: "v-001" }), {
                headers: { Authorization: `Bearer ${wrongIssuer}` },
            }),
            (err: unknown) => err instanceof ConnectError && err.code === Code.Unauthenticated,
        );
        assert.equal(starts.length, before);
    });

    it("gateway auth: StartTrip with a WRONG AUDIENCE token is rejected as Unauthenticated", async () => {
        const before = starts.length;
        const wrongAudience = await mint({ sub: "user-42", name: "Dana", audience: "some-other-api" });
        await assert.rejects(
            trips.startTrip(create(StartTripRequestSchema, { userId: "user-42", vehicleId: "v-001" }), {
                headers: { Authorization: `Bearer ${wrongAudience}` },
            }),
            (err: unknown) => err instanceof ConnectError && err.code === Code.Unauthenticated,
        );
        assert.equal(starts.length, before);
    });

    it("gateway auth: StartTrip with an EXPIRED token is rejected as Unauthenticated", async () => {
        const before = starts.length;
        // ttl in the past → `exp` already elapsed at verification time.
        const expired = await mint({ sub: "user-42", name: "Dana", ttl: "-1m" });
        await assert.rejects(
            trips.startTrip(create(StartTripRequestSchema, { userId: "user-42", vehicleId: "v-001" }), {
                headers: { Authorization: `Bearer ${expired}` },
            }),
            (err: unknown) => err instanceof ConnectError && err.code === Code.Unauthenticated,
        );
        assert.equal(starts.length, before);
    });

    it("internal FleetService is public: a direct in-process GetVehicle needs no token", async () => {
        // Proves fleet/billing are reachable WITHOUT auth — the "services trust
        // the gateway" model. localClient dispatches in-process through the same
        // interceptor chain; the public annotation lets it through.
        const fleet = server.localClient(FleetService);
        const res = await fleet.getVehicle({ id: "v-002" });
        assert.equal(res.vehicle?.model, "Renault Zoe");
        assert.equal(res.vehicle?.available, true);
    });
});
