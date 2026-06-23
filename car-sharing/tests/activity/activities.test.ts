/**
 * Activity ↔ RPC wiring + compensation idempotency tests — DOCKERLESS.
 *
 * Runs the REAL activity bodies (via `MockActivityEnvironment`) against a REAL
 * in-process Connectum monolith (`buildServer({ port: 0 })`) — the same server
 * the e2e uses, with a PGlite-backed FleetService and the in-memory
 * BillingService/TripService. No Temporal cluster, no Docker. This proves:
 *
 *  - each forward activity calls its RPC and mutates the real service state
 *    (`tabCount`/`chargeCount`/`tripStatus`), including the happy-path billing
 *    side effects (openTab → addCharge → settle) that MOVED off the e2e from
 *    Phase 1's synchronous StartTrip;
 *  - the compensating activities are IDEMPOTENT — running release/void/refund
 *    twice (or on already-undone state) is a no-op success.
 *
 * The activities read endpoints from `*_ADDR`; this test points all three at the
 * one in-process monolith before any activity builds its (lazily cached) client.
 *
 * @module tests/activity/activities
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Server } from "@connectum/core";
import { ApplicationFailure } from "@temporalio/activity";
import { MockActivityEnvironment } from "@temporalio/testing";
import { buildServer } from "#server.ts";
import { activeChargeCount, chargeCount, openTabCount, resetBilling, tabCount } from "#services/billingService.ts";
import { resetTrips, tripStatus } from "#services/tripService.ts";
import * as activities from "#temporal/activities.ts";
import { TripStatus } from "#temporal/tripStatus.ts";
import { resolveTopology } from "#topology.ts";
import { makeTestDb, reseed } from "../helpers/db.ts";

const env = new MockActivityEnvironment();

/** Run a real activity body inside a mocked Temporal Activity Context. */
function run<A extends unknown[], R>(fn: (...args: A) => Promise<R>, ...args: A): Promise<R> {
    return env.run(fn, ...args);
}

describe("Activities: real RPC wiring + compensation idempotency (in-process monolith, PGlite)", () => {
    let server: Server;
    let db: Awaited<ReturnType<typeof makeTestDb>>;

    before(async () => {
        const topology = resolveTopology("*");
        db = await makeTestDb();
        // Mount trips without a Temporal client (`null`): only RecordTrip/EndTrip
        // are exercised here, which never touch the workflow client.
        server = buildServer({ port: 0, topology, db, workflowClient: null });
        await server.start();
        const port = server.address?.port ?? 0;
        const addr = `http://localhost:${port}`;
        // Point every activity client at the one in-process monolith. Set BEFORE
        // the first activity call, since activities cache their clients lazily.
        process.env.FLEET_ADDR = addr;
        process.env.TRIPS_ADDR = addr;
        process.env.BILLING_ADDR = addr;
    });

    beforeEach(async () => {
        await reseed(db);
        resetBilling();
        resetTrips();
    });

    after(async () => {
        if (server.state === "running") await server.stop();
    });

    it("forward billing steps open a tab, add a charge, and settle (the moved happy-path side effects)", async () => {
        const tripId = "trip-act-1";
        assert.equal(tabCount(), 0);
        assert.equal(chargeCount(), 0);

        await run(activities.openTab, { tripId });
        assert.equal(tabCount(), 1);
        assert.equal(openTabCount(), 1);

        const chargeId = await run(activities.addCharge, { tripId, durationMs: 60_000 });
        assert.ok(chargeId.startsWith("charge-"));
        assert.equal(chargeCount(), 1);
        assert.equal(activeChargeCount(), 1);

        await run(activities.settle, { tripId });
        // Settle closes the tab (no longer open) but does not remove it.
        assert.equal(tabCount(), 1);
        assert.equal(openTabCount(), 0);
    });

    it("reserveVehicle drives FleetService and recordTrip/endTrip drive the trip ledger", async () => {
        const tripId = "trip-act-2";
        await run(activities.reserveVehicle, { vehicleId: "v-001", holderId: tripId });

        await run(activities.recordTrip, { userId: "user-42", vehicleId: "v-001", tripId });
        assert.equal(tripStatus(tripId), TripStatus.STARTED);

        await run(activities.endTrip, { tripId });
        assert.equal(tripStatus(tripId), TripStatus.ENDED);
    });

    it("reserveVehicle on an UNAVAILABLE vehicle throws a NON-RETRYABLE VehicleUnavailable ApplicationFailure", async () => {
        // v-003 is maintenance in the seed → ReserveVehicle is FAILED_PRECONDITION,
        // which the activity rethrows as a non-retryable ApplicationFailure whose
        // `type` is exactly the value the workflow lists in nonRetryableErrorTypes.
        await assert.rejects(
            run(activities.reserveVehicle, { vehicleId: "v-003", holderId: "trip-unavail" }),
            (err: unknown) =>
                err instanceof ApplicationFailure && err.type === "VehicleUnavailable" && err.nonRetryable === true && /not available/i.test(err.message),
        );
    });

    it("reserveVehicle on an UNKNOWN vehicle also throws a NON-RETRYABLE VehicleUnavailable ApplicationFailure", async () => {
        await assert.rejects(
            run(activities.reserveVehicle, { vehicleId: "ghost", holderId: "trip-ghost" }),
            (err: unknown) => err instanceof ApplicationFailure && err.type === "VehicleUnavailable" && err.nonRetryable === true,
        );
    });

    it("reserveVehicle is idempotent for the SAME holder: a retry observing its own reservation succeeds", async () => {
        // A Temporal retry re-runs the activity. Re-reserving the SAME vehicle
        // with the SAME holder must succeed (no VehicleUnavailable): the holder
        // proves this is our own prior commit, not a conflicting second trip.
        await run(activities.reserveVehicle, { vehicleId: "v-001", holderId: "trip-A" });
        await run(activities.reserveVehicle, { vehicleId: "v-001", holderId: "trip-A" });
    });

    it("reserveVehicle rejects a DIFFERENT holder on a held vehicle (no double-booking)", async () => {
        // trip-A holds v-001; trip-B must NOT be able to reserve it — the guard
        // that keeps two trips off one vehicle. The activity rethrows the conflict
        // as a non-retryable VehicleUnavailable.
        await run(activities.reserveVehicle, { vehicleId: "v-001", holderId: "trip-A" });
        await assert.rejects(
            run(activities.reserveVehicle, { vehicleId: "v-001", holderId: "trip-B" }),
            (err: unknown) => err instanceof ApplicationFailure && err.type === "VehicleUnavailable" && err.nonRetryable === true,
        );
    });

    it("releaseVehicle is idempotent: releasing an already-available vehicle is a no-op success", async () => {
        await run(activities.reserveVehicle, { vehicleId: "v-001", holderId: "trip-release" });
        await run(activities.releaseVehicle, { vehicleId: "v-001" });
        // Second release on an already-available vehicle must not throw.
        await run(activities.releaseVehicle, { vehicleId: "v-001" });
    });

    it("voidTab is idempotent: voiding twice (and a missing tab) is a no-op success", async () => {
        const tripId = "trip-act-void";
        await run(activities.openTab, { tripId });
        await run(activities.voidTab, { tripId });
        assert.equal(openTabCount(), 0);
        // Void again — already void.
        await run(activities.voidTab, { tripId });
        // Void a trip that never had a tab — still a no-op success.
        await run(activities.voidTab, { tripId: "trip-never" });
    });

    it("refundCharge is idempotent: refunding twice (and an unknown charge) is a no-op success", async () => {
        const tripId = "trip-act-refund";
        const chargeId = await run(activities.addCharge, { tripId, durationMs: 30_000 });
        assert.equal(activeChargeCount(), 1);

        await run(activities.refundCharge, { tripId, chargeId });
        assert.equal(activeChargeCount(), 0);
        // Refund again — already refunded.
        await run(activities.refundCharge, { tripId, chargeId });
        // Refund an unknown charge — still a no-op success.
        await run(activities.refundCharge, { tripId, chargeId: "charge-ghost" });
    });

    it("markTripCancelled overrides a recorded trip to CANCELLED and never downgrades", async () => {
        const tripId = "trip-act-cancel";
        await run(activities.recordTrip, { userId: "user-42", vehicleId: "v-002", tripId });
        await run(activities.markTripCancelled, { tripId });
        assert.equal(tripStatus(tripId), TripStatus.CANCELLED);
        // A late endTrip(ENDED) must not resurrect the trip.
        await run(activities.endTrip, { tripId });
        assert.equal(tripStatus(tripId), TripStatus.CANCELLED);
    });
});
