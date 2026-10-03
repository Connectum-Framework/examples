/**
 * E2E — SPLIT topology: trips and fleet as two separate servers.
 *
 * The monolith e2e proves the IN-PROCESS pre-check path (`ctx.call` over the
 * local transport, signed by `outgoingInterceptors`). Core applies those
 * interceptors only to the local transport, so a split deployment depends on a
 * different piece of wiring: the remote resolver's transport, which must sign
 * the call to FleetService itself. This suite runs a fleet-only and a
 * trips-only server in one process, with `FLEET_ADDR` pointing trips at fleet
 * over real gRPC, and asserts the pre-check still passes fleet's internal auth.
 * If the network transport were unsigned, StartTrip would fail with
 * Unauthenticated from fleet instead of starting the workflow.
 *
 * Temporal is a stub; user JWTs are minted against an in-process JWKS exactly
 * as in the monolith e2e.
 *
 * @module tests/e2e/split
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { TestJwksServer } from "@connectum/auth/testing";
import { createTestJwtRS256, generateRsaTestKeypair, startTestJwksServer } from "@connectum/auth/testing";
import type { Server } from "@connectum/core";
import { JWT_AUDIENCE, JWT_ISSUER } from "#auth.ts";
import { FleetService } from "#gen/fleet/v1/fleet_pb.ts";
import { StartTripRequestSchema, TripService } from "#gen/trips/v1/trips_pb.ts";
import { buildServer } from "#server.ts";
import type { TripWorkflowClient } from "#services/tripService.ts";
import { resolveTopology, TYPE_NAMES } from "#topology.ts";
import { makeTestDb } from "../helpers/db.ts";
import type { InternalAuthFixture } from "../helpers/internalAuth.ts";
import { startInternalAuth } from "../helpers/internalAuth.ts";

describe("E2E: split topology — trips reaches fleet over gRPC with a signed service token", () => {
    let fleetServer: Server;
    let tripsServer: Server;
    let userJwks: TestJwksServer;
    let internalAuth: InternalAuthFixture;
    let trips: Client<typeof TripService>;
    let userToken: string;
    const startedWorkflowIds: string[] = [];
    const savedFleetAddr = process.env.FLEET_ADDR;

    before(async () => {
        internalAuth = await startInternalAuth();
        const keypair = await generateRsaTestKeypair();
        userJwks = await startTestJwksServer(keypair.publicJwk);
        userToken = await createTestJwtRS256(keypair.privateKey, { sub: "user-42", roles: ["rider"] }, { kid: keypair.kid, issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: "5m" });

        // buildServer constructs the fleet db for every role (the trips role never
        // queries it), so both get the same PGlite instance instead of a
        // DATABASE_URL.
        const db = await makeTestDb();

        // fleet role: hosts no TripService, so it needs no signer — it only
        // verifies the tokens of its callers.
        fleetServer = buildServer({
            port: 0,
            topology: resolveTopology(TYPE_NAMES.fleet),
            db,
            jwksUri: userJwks.url,
            internalIssuers: internalAuth.issuers,
        });
        await fleetServer.start();
        // The trips role's resolver reads FLEET_ADDR on its first call to fleet.
        process.env.FLEET_ADDR = `http://localhost:${fleetServer.address?.port ?? 0}`;

        const workflowClient: TripWorkflowClient = {
            async start(_workflowType, options) {
                startedWorkflowIds.push(options.workflowId);
                return { workflowId: options.workflowId };
            },
            getHandle() {
                throw new Error("GetTrip is not exercised by this suite");
            },
        };
        tripsServer = buildServer({
            port: 0,
            topology: resolveTopology(TYPE_NAMES.trips),
            db,
            jwksUri: userJwks.url,
            workflowClient,
            internalSigner: internalAuth.trips,
            internalIssuers: internalAuth.issuers,
        });
        await tripsServer.start();
        trips = createClient(TripService, createGrpcTransport({ baseUrl: `http://localhost:${tripsServer.address?.port ?? 0}` }));
    });

    after(async () => {
        if (tripsServer?.state === "running") await tripsServer.stop();
        if (fleetServer?.state === "running") await fleetServer.stop();
        await userJwks.close();
        await internalAuth.close();
        if (savedFleetAddr === undefined) {
            delete process.env.FLEET_ADDR;
        } else {
            process.env.FLEET_ADDR = savedFleetAddr;
        }
    });

    it("each role mounts only its own service", () => {
        assert.equal(tripsServer.hasService(TripService), true);
        assert.equal(tripsServer.hasService(FleetService), false);
        assert.equal(fleetServer.hasService(FleetService), true);
        assert.equal(fleetServer.hasService(TripService), false);
    });

    it("StartTrip's remote pre-check passes fleet's internal auth and the workflow starts", async () => {
        const res = await trips.startTrip(create(StartTripRequestSchema, { userId: "user-42", vehicleId: "v-001" }), {
            headers: { Authorization: `Bearer ${userToken}` },
        });
        assert.equal(res.trip?.status, "STARTED");
        assert.deepEqual(startedWorkflowIds, [res.trip?.id]);
    });

    it("fleet's NotFound still crosses the network unchanged (the call was authorized, then answered)", async () => {
        await assert.rejects(
            trips.startTrip(create(StartTripRequestSchema, { userId: "user-42", vehicleId: "ghost" }), {
                headers: { Authorization: `Bearer ${userToken}` },
            }),
            (err: unknown) => err instanceof ConnectError && err.code === Code.NotFound,
        );
    });
});
