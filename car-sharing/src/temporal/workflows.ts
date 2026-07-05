/**
 * TripWorkflow — the durable trip saga (Temporal workflow code).
 *
 * This file is the worker's `workflowsPath` target: it is bundled (webpack +
 * swc) and runs in Temporal's DETERMINISTIC sandbox. It therefore imports ONLY
 * `@temporalio/workflow`, the activity *types*, and the side-effect-free
 * `tripStatus.ts` — never Node built-ins, Connectum, or the generated runtime
 * (that would break determinism). All I/O is in the activities; the workflow
 * only orchestrates.
 *
 * Saga (compensation-stack pattern): run the forward steps in order, registering
 * each step's compensation on a LIFO stack — BEFORE the forward call when the
 * compensation's inputs are already known (so an ambiguous failure that DID
 * commit the side effect is still unwound), or AFTER when the compensation needs
 * the call's result (the charge id). On ANY failure, run the compensations in
 * LIFO order (each wrapped in its own try/catch so the unwind never throws),
 * then rethrow the original error. The result:
 *   - settle fails  → refundCharge → voidTab → markTripCancelled → releaseVehicle
 *   - endTrip fails → markTripCancelled → releaseVehicle
 *   - reserve fails → (non-retryable) fail fast, NOTHING to compensate.
 *
 * endTrip (step 4) and settle (step 7) push NO compensation: rollback after
 * step 4+ reuses step 2's markTripCancelled, and settle is terminal.
 *
 * Live status is exposed via `getTripStatusQuery` so the gateway's GetTrip can
 * read it with `handle.query(getTripStatusQuery)`.
 *
 * @module temporal/workflows
 */

import { ApplicationFailure, defineQuery, log, proxyActivities, setHandler, sleep } from "@temporalio/workflow";
import type * as activities from "#temporal/activities.ts";
import type { TripStatus as TripStatusT } from "#temporal/tripStatus.ts";
import { TripStatus } from "#temporal/tripStatus.ts";

/** Input to {@link TripWorkflow}. */
export interface TripWorkflowInput {
    readonly userId: string;
    readonly vehicleId: string;
    readonly tripId: string;
}

/**
 * Query for the trip's live status, read from outside via
 * `handle.query(getTripStatusQuery)`. Returns the current {@link TripStatus}.
 */
export const getTripStatusQuery = defineQuery<TripStatusT>("getTripStatus");

/** A single compensation: a label (for assertions/logs) and its undo action. */
interface Compensation {
    readonly name: string;
    readonly run: () => Promise<void>;
}

/**
 * Activity proxies. `reserveVehicle`'s business failure is non-retryable (the
 * activity rethrows `ApplicationFailure(VEHICLE_UNAVAILABLE)`); every other
 * step keeps Temporal's default retry policy, which is the durability the saga
 * demonstrates.
 */
const acts = proxyActivities<typeof activities>({
    startToCloseTimeout: "30 seconds",
    retry: {
        initialInterval: "1 second",
        maximumAttempts: 5,
        // Business availability failures must not be retried.
        nonRetryableErrorTypes: ["VehicleUnavailable"],
    },
});

/** Simulated drive duration (time-skipped instantly in tests). */
const DRIVE_DURATION_MS = 60_000;

/**
 * Run the trip saga for `(userId, vehicleId, tripId)`.
 *
 * @param input - {@link TripWorkflowInput}.
 * @returns the terminal trip status (`SETTLED` on success).
 */
export async function TripWorkflow(input: TripWorkflowInput): Promise<TripStatusT> {
    const { userId, vehicleId, tripId } = input;

    let status: TripStatusT = TripStatus.STARTED;
    setHandler(getTripStatusQuery, () => status);

    // LIFO compensation stack: each step registers its compensation here, BEFORE
    // its forward call where the inputs are already known (so an ambiguous
    // failure that committed the side effect is still unwound), or AFTER where
    // the compensation needs the call's result.
    const compensations: Compensation[] = [];

    try {
        // Step 1 — reserve the vehicle. `holderId: tripId` makes the reserve
        // idempotent across Temporal retries (the same holder re-reserving its
        // own vehicle succeeds). A business failure here is non-retryable and
        // fails the workflow fast; registered AFTER, since a failed reserve held
        // nothing and the release would have nothing to undo.
        await acts.reserveVehicle({ vehicleId, holderId: tripId });
        compensations.unshift({ name: "releaseVehicle", run: () => acts.releaseVehicle({ vehicleId }) });

        // Step 2 — record the trip (STARTED). Register the cancel BEFORE the
        // call: markTripCancelled is idempotent (a no-op if the record never
        // committed), so an ambiguous recordTrip failure is still unwound.
        compensations.unshift({ name: "markTripCancelled", run: () => acts.markTripCancelled({ tripId }) });
        await acts.recordTrip({ userId, vehicleId, tripId });
        status = TripStatus.STARTED;

        // Step 3 — the drive. A timer; time-skipped instantly under test.
        await sleep(DRIVE_DURATION_MS);

        // Step 4 — end the trip (ENDED). No own compensation: a later failure
        // rolls the trip back to CANCELLED via step 2's compensation.
        await acts.endTrip({ tripId });
        status = TripStatus.ENDED;

        // Step 5 — open the billing tab. Register the void BEFORE the call:
        // voidTab is idempotent (a no-op on a missing tab), so an ambiguous
        // openTab failure is still unwound.
        compensations.unshift({ name: "voidTab", run: () => acts.voidTab({ tripId }) });
        await acts.openTab({ tripId });

        // Step 6 — add the charge derived from the drive duration.
        const chargeId = await acts.addCharge({ tripId, durationMs: DRIVE_DURATION_MS });
        compensations.unshift({ name: "refundCharge", run: () => acts.refundCharge({ tripId, chargeId }) });

        // Step 7 — settle the tab. Terminal; no compensation.
        await acts.settle({ tripId });
        status = TripStatus.SETTLED;

        return status;
    } catch (err) {
        // Unwind in LIFO order; each compensation is isolated so the unwind
        // never throws. Temporal already retried each forward+comp activity.
        log.warn("TripWorkflow failed; compensating", { tripId, error: String(err) });
        for (const comp of compensations) {
            try {
                await comp.run();
            } catch (compErr) {
                log.error("compensation failed (continuing unwind)", { tripId, compensation: comp.name, error: String(compErr) });
            }
        }
        status = TripStatus.CANCELLED;
        // Preserve the original failure so it surfaces in temporal-ui / GetTrip.
        if (err instanceof ApplicationFailure) throw err;
        throw ApplicationFailure.create({ message: String(err), type: "TripWorkflowFailed" });
    }
}
