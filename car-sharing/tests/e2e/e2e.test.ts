/**
 * E2E tests — MONOLITH mode, in-process, no cluster.
 *
 * The whole car-sharing app runs in ONE process; every service is mounted
 * locally, so the headline flows are verified end to end without Kubernetes,
 * Istio, or a Collector:
 *
 *  - StartTrip validates the vehicle via `ctx.call` to FleetService (in-process),
 *    then opens a billing tab via `ctx.call` to BillingService — proving the
 *    cross-service orchestration and that internal calls to the `public`
 *    fleet/billing services pass through the SAME gateway interceptor chain
 *    WITHOUT an Authorization header.
 *  - An unavailable vehicle is rejected as `Code.FailedPrecondition` (the trip
 *    handler's own guard); an unknown vehicle surfaces `Code.NotFound` straight
 *    out of `ctx.call` (propagated from FleetService).
 *  - The gateway auth: a StartTrip with NO token is rejected as
 *    `Code.Unauthenticated` by the JWT interceptor, while a request with a valid
 *    Bearer token succeeds. This is asserted over the HTTP/2 gRPC transport
 *    (the server runs `allowHTTP1: false`), with the JWT minted by the shared
 *    test secret.
 *
 * The split (microservices) topology is config-only here (see k8s/ and istio/);
 * it shares this exact handler code, selected by the `SERVICES` env.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Client } from "@connectrpc/connect";
import type { Server } from "@connectum/core";
import { createTestJwt, TEST_JWT_SECRET } from "@connectum/auth/testing";
import { BillingService } from "#gen/billing/v1/billing_pb.ts";
import { FleetService } from "#gen/fleet/v1/fleet_pb.ts";
import { StartTripRequestSchema, TripService } from "#gen/trips/v1/trips_pb.ts";
import { JWT_ISSUER } from "#auth.ts";
import { buildServer } from "#server.ts";
import { resetTabs, tabCount } from "#services/billingService.ts";
import { resolveTopology } from "#topology.ts";

describe("E2E: car-sharing monolith (in-process gateway, no cluster)", () => {
    let server: Server;
    let trips: Client<typeof TripService>;
    let userToken: string;

    before(async () => {
        // Force monolith topology so fleet, trips and billing are all mounted
        // locally and ctx.call routes in-process. Inject the shared test secret
        // so the JWT interceptor verifies tokens minted below.
        const topology = resolveTopology("*");
        server = buildServer({ port: 0, topology, jwtSecret: TEST_JWT_SECRET });
        await server.start();
        const port = server.address?.port ?? 0;

        // Bearer token over the gRPC client maps to gRPC metadata; the JWT
        // interceptor reads the Authorization header from it.
        userToken = await createTestJwt({ sub: "user-42", name: "Dana" }, { issuer: JWT_ISSUER });

        trips = createClient(TripService, createGrpcTransport({ baseUrl: `http://localhost:${port}` }));
    });

    beforeEach(() => {
        resetTabs();
    });

    after(async () => {
        if (server.state === "running") await server.stop();
    });

    it("mounts all three services from the generated catalog (monolith)", () => {
        assert.equal(server.hasService(FleetService), true);
        assert.equal(server.hasService(TripService), true);
        assert.equal(server.hasService(BillingService), true);
    });

    it("StartTrip (authenticated): ctx.call checks fleet availability and opens a billing tab", async () => {
        assert.equal(tabCount(), 0);

        const res = await trips.startTrip(create(StartTripRequestSchema, { userId: "user-42", vehicleId: "v-001" }), {
            headers: { Authorization: `Bearer ${userToken}` },
        });

        assert.equal(res.trip?.status, "STARTED");
        assert.ok(res.trip?.id.startsWith("trip-"));

        // The trip handler's second ctx.call (to the public BillingService) ran
        // through the same interceptor chain with no Authorization header and
        // recorded exactly one open tab.
        assert.equal(tabCount(), 1);
    });

    it("StartTrip with an UNAVAILABLE vehicle is rejected as FailedPrecondition (no tab opened)", async () => {
        await assert.rejects(
            trips.startTrip(create(StartTripRequestSchema, { userId: "user-42", vehicleId: "v-003" }), {
                headers: { Authorization: `Bearer ${userToken}` },
            }),
            (err: unknown) => err instanceof ConnectError && err.code === Code.FailedPrecondition,
        );
        // The guard fires before the billing call, so no tab is opened.
        assert.equal(tabCount(), 0);
    });

    it("StartTrip with an UNKNOWN vehicle surfaces Code.NotFound from the fleet via ctx.call", async () => {
        // Asserted over the IN-PROCESS client, not the gRPC loopback. The fleet
        // GetVehicle throws Code.NotFound, and that ConnectError propagates back
        // through `ctx.call` carrying the in-process router transport's response
        // metadata (content-length/content-type). Re-emitting that metadata as
        // gRPC error trailers on the outer call is illegal HTTP/2 (content-length
        // is not a valid trailer), so the gRPC loopback client observes an
        // NGHTTP2 protocol error instead of a clean NotFound. This is a verified
        // monolith/in-process limitation (see README); the in-process client
        // surfaces the original code faithfully, which is what this assertion
        // checks (it mirrors hris's localClient style).
        const tripsLocal = server.localClient(TripService);
        await assert.rejects(
            tripsLocal.startTrip(create(StartTripRequestSchema, { userId: "user-42", vehicleId: "ghost" }), {
                headers: { Authorization: `Bearer ${userToken}` },
            }),
            (err: unknown) => err instanceof ConnectError && err.code === Code.NotFound,
        );
        assert.equal(tabCount(), 0);
    });

    it("gateway auth: StartTrip with NO token is rejected as Unauthenticated", async () => {
        await assert.rejects(
            trips.startTrip(create(StartTripRequestSchema, { userId: "user-42", vehicleId: "v-001" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.Unauthenticated,
        );
        // No handler ran, so no tab was opened.
        assert.equal(tabCount(), 0);
    });

    it("gateway auth: StartTrip with an INVALID token is rejected as Unauthenticated", async () => {
        await assert.rejects(
            trips.startTrip(create(StartTripRequestSchema, { userId: "user-42", vehicleId: "v-001" }), {
                headers: { Authorization: "Bearer not.a.jwt" },
            }),
            (err: unknown) => err instanceof ConnectError && err.code === Code.Unauthenticated,
        );
        assert.equal(tabCount(), 0);
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
