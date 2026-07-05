/**
 * Temporal activities — the saga's side effects, each a ConnectRPC call.
 *
 * Activities run in the worker's Node process (NOT the deterministic workflow
 * sandbox), so they may freely create ConnectRPC clients and do I/O. Each
 * activity is one RPC against a role service over the network (`*_ADDR`). The
 * workflow (`workflows.ts`) only `proxyActivities` these and never touches a
 * client itself.
 *
 * Activities are grouped:
 *  - forward steps: reserveVehicle, recordTrip, endTrip, openTab, addCharge,
 *    settle.
 *  - compensations: releaseVehicle, markTripCancelled, voidTab, refundCharge —
 *    all IDEMPOTENT (the services no-op on already-done state), since a
 *    compensation may run after a forward step partially applied.
 *
 * Business failures of the very first step (vehicle unavailable / unknown) are
 * rethrown as a NON-RETRYABLE `ApplicationFailure` so Temporal fails the
 * workflow fast (no pointless retries, no compensation — nothing was reserved).
 * Transient/infra failures of every other step stay retryable, which is the
 * whole point of the durable saga, so they are NOT marked non-retryable here.
 *
 * @module temporal/activities
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ApplicationFailure } from "@temporalio/activity";
import { AddChargeRequestSchema, OpenTabRequestSchema, RefundChargeRequestSchema, SettleRequestSchema, VoidTabRequestSchema } from "#gen/billing/v1/billing_pb.ts";
import { ReleaseVehicleRequestSchema, ReserveVehicleRequestSchema } from "#gen/fleet/v1/fleet_pb.ts";
import { EndTripRequestSchema, RecordTripRequestSchema } from "#gen/trips/v1/trips_pb.ts";
import type { ServiceClients } from "#temporal/clients.ts";
import { createServiceClients } from "#temporal/clients.ts";
import { TripStatus } from "#temporal/tripStatus.ts";

/**
 * Error type for a non-retryable, business availability failure of step 1.
 * The workflow lists this string in `nonRetryableErrorTypes` (by the SAME
 * literal value) and surfaces it as a terminal workflow failure (preserving
 * today's FAILED_PRECONDITION/NOT_FOUND meaning).
 *
 * NOT exported: only used inside this module, and keeping the activities
 * namespace function-only (so `import * as activities` passed to `Worker.create`
 * carries no non-function entry).
 */
const VEHICLE_UNAVAILABLE = "VehicleUnavailable" as const;

/** Charge rate in minor units (cents) per second of trip — demo pricing. */
const CENTS_PER_SECOND = 5;

/** Lazily-built shared clients (one transport set per worker process). */
let sharedClients: ServiceClients | undefined;

/** Get (or build once) the worker's service clients. */
function clients(): ServiceClients {
    if (sharedClients === undefined) {
        sharedClients = createServiceClients();
    }
    return sharedClients;
}

/** Compute a demo charge (in cents) from a trip's duration in milliseconds. */
function chargeCents(durationMs: number): bigint {
    const seconds = Math.max(1, Math.ceil(durationMs / 1000));
    return BigInt(seconds * CENTS_PER_SECOND);
}

// ── Forward steps ─────────────────────────────────────────────────────────

/**
 * Step 1 — reserve the vehicle. `holderId` (the trip/workflow id) is the
 * reservation owner: it makes the reserve idempotent across Temporal retries, so
 * a retry that observes its OWN prior commit succeeds instead of being mistaken
 * for a conflict. A real business failure (unavailable / unknown / a different
 * holder) is rethrown as a NON-RETRYABLE `ApplicationFailure(VEHICLE_UNAVAILABLE)`
 * so the workflow fails fast with no compensation; any other (infra) error stays
 * retryable.
 *
 * @param input - `{ vehicleId, holderId }`.
 */
export async function reserveVehicle(input: { vehicleId: string; holderId: string }): Promise<void> {
    try {
        await clients().fleet.reserveVehicle(create(ReserveVehicleRequestSchema, { id: input.vehicleId, holderId: input.holderId }));
    } catch (err) {
        if (err instanceof ConnectError && (err.code === Code.FailedPrecondition || err.code === Code.NotFound)) {
            throw ApplicationFailure.create({
                message: err.message,
                type: VEHICLE_UNAVAILABLE,
                nonRetryable: true,
            });
        }
        throw err;
    }
}

/** Compensation for step 1 — release the vehicle. Idempotent. */
export async function releaseVehicle(input: { vehicleId: string }): Promise<void> {
    await clients().fleet.releaseVehicle(create(ReleaseVehicleRequestSchema, { id: input.vehicleId }));
}

/** Step 2 — create the trip ledger row (status STARTED). */
export async function recordTrip(input: { userId: string; vehicleId: string; tripId: string }): Promise<void> {
    await clients().trips.recordTrip(create(RecordTripRequestSchema, { userId: input.userId, vehicleId: input.vehicleId, tripId: input.tripId }));
}

/** Compensation for step 2 — mark the trip CANCELLED. Idempotent. */
export async function markTripCancelled(input: { tripId: string }): Promise<void> {
    await clients().trips.endTrip(create(EndTripRequestSchema, { tripId: input.tripId, status: TripStatus.CANCELLED }));
}

/** Step 4 — close the trip (status ENDED). No own compensation (step 2's covers rollback). */
export async function endTrip(input: { tripId: string }): Promise<void> {
    await clients().trips.endTrip(create(EndTripRequestSchema, { tripId: input.tripId, status: TripStatus.ENDED }));
}

/** Step 5 — open the billing tab. */
export async function openTab(input: { tripId: string }): Promise<void> {
    await clients().billing.openTab(create(OpenTabRequestSchema, { tripId: input.tripId }));
}

/** Compensation for step 5 — void the tab. Idempotent. */
export async function voidTab(input: { tripId: string }): Promise<void> {
    await clients().billing.voidTab(create(VoidTabRequestSchema, { tripId: input.tripId }));
}

/**
 * Step 6 — add a charge derived from the trip duration; returns the charge id
 * (the workflow remembers it so its compensation can refund precisely).
 *
 * @param input - `{ tripId, durationMs }`.
 */
export async function addCharge(input: { tripId: string; durationMs: number }): Promise<string> {
    const res = await clients().billing.addCharge(create(AddChargeRequestSchema, { tripId: input.tripId, amountCents: chargeCents(input.durationMs) }));
    return res.chargeId;
}

/** Compensation for step 6 — refund the charge by id. Idempotent. */
export async function refundCharge(input: { tripId: string; chargeId: string }): Promise<void> {
    await clients().billing.refundCharge(create(RefundChargeRequestSchema, { tripId: input.tripId, chargeId: input.chargeId }));
}

/** Step 7 — settle (finalize) the tab. The terminal happy-path step. */
export async function settle(input: { tripId: string }): Promise<void> {
    await clients().billing.settle(create(SettleRequestSchema, { tripId: input.tripId }));
}
