/**
 * TripService — the edge orchestrator, now backed by a durable Temporal saga.
 *
 * Phase 1 did the whole flow inline with two `ctx.call`s. Phase 2 splits it:
 *
 *  - `StartTrip` keeps a SYNCHRONOUS availability pre-check via
 *    `ctx.call("fleet.v1.FleetService/GetVehicle", …)` — preserving the exact
 *    edge error contract (unknown vehicle → `Code.NotFound` propagated from the
 *    fleet; unavailable vehicle → `Code.FailedPrecondition` raised here). Only
 *    AFTER the pre-check passes does it START the durable `TripWorkflow`
 *    (`workflowClient.start(TripWorkflow, { workflowId: tripId })`) and return
 *    `{ trip: { id, status: STARTED }, workflowId }`. The long-running saga
 *    (reserve → record → end → openTab → addCharge → settle, with automatic
 *    compensation) runs in Temporal, not in this handler.
 *  - `GetTrip` reads LIVE status from the workflow via a Temporal Workflow Query
 *    (`handle.query(getTripStatusQuery)`), falling back to a terminal status
 *    derived from `handle.describe()` once the workflow has closed.
 *  - `RecordTrip` / `EndTrip` are the INTERNAL RPCs the worker's activities call
 *    (method-level `public` in proto). They own the in-memory trip ledger.
 *
 * The Temporal client is INJECTED via the {@link createTripService} factory
 * (mirroring `createFleetService(db)`), so the server can supply a lazy
 * `@temporalio/client` `WorkflowClient` in production and tests can inject a
 * stub. When no client is configured (e.g. a non-trips role, or the
 * server-only e2e), `StartTrip`'s workflow start and `GetTrip` raise
 * `Code.Unavailable` — but the pre-check still runs first, so the error-path
 * e2e needs no live Temporal.
 *
 * @module services/tripService
 */

import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ServiceDefinition } from "@connectum/core";
import { defineService } from "@connectum/core";
import { QueryNotRegisteredError, QueryRejectedError, WorkflowNotFoundError } from "@temporalio/client";
import { GetVehicleRequestSchema } from "#gen/fleet/v1/fleet_pb.ts";
import { EndTripResponseSchema, GetTripResponseSchema, RecordTripResponseSchema, StartTripResponseSchema, TripSchema, TripService } from "#gen/trips/v1/trips_pb.ts";
import type { TripStatus as TripStatusT } from "#temporal/tripStatus.ts";
import { TripStatus } from "#temporal/tripStatus.ts";
import type { TripWorkflowInput } from "#temporal/workflows.ts";

// ── Temporal client port ────────────────────────────────────────────────────
// A minimal structural interface over the `@temporalio/client` `WorkflowClient`
// the handler actually uses. Typing against a port (not the concrete class)
// keeps the service import-light and lets tests inject a stub. The real
// `WorkflowClient` satisfies this shape.

/** A handle subset: query the live status and describe the (possibly closed) run. */
export interface TripWorkflowHandle {
    query<Ret>(queryName: string): Promise<Ret>;
    describe(): Promise<{ status: { name: string } }>;
}

/** The Temporal client subset the trip handler depends on. */
export interface TripWorkflowClient {
    start(workflowType: string, options: { taskQueue: string; workflowId: string; args: [TripWorkflowInput] }): Promise<{ workflowId: string }>;
    getHandle(workflowId: string): TripWorkflowHandle;
}

/** Options for {@link createTripService}. */
export interface TripServiceOptions {
    /**
     * Temporal client used to start the saga and read status. Optional: when
     * absent, the pre-check still runs, but starting the workflow / reading
     * status raises `Code.Unavailable` (so non-trips roles and the server-only
     * e2e build and run without Temporal).
     */
    readonly workflowClient?: TripWorkflowClient;
    /** Task queue to start workflows on. */
    readonly taskQueue: string;
}

// ── In-memory trip ledger ────────────────────────────────────────────────────
// The activities (via RecordTrip/EndTrip) own this; StartTrip does NOT write it
// (the workflow's recordTrip activity does). DURABLE state lives in Temporal.

/** A trip record keyed by trip id. */
interface TripRecord {
    id: string;
    userId: string;
    vehicleId: string;
    status: TripStatusT;
}

/** Demo ledger of trips (trip id → record). */
const trips = new Map<string, TripRecord>();

/** Reset the trip ledger — used between tests. */
export function resetTrips(): void {
    trips.clear();
}

/** Number of trips currently recorded (used by tests to assert side effects). */
export function tripCount(): number {
    return trips.size;
}

/** Read a recorded trip's status (test/inspection helper). */
export function tripStatus(tripId: string): TripStatusT | undefined {
    return trips.get(tripId)?.status;
}

/** Map a closed-workflow status name to a terminal trip status for GetTrip. */
function terminalStatusFor(workflowStatusName: string): TripStatusT {
    // A completed saga settled the trip; anything else (FAILED/CANCELLED/
    // TERMINATED/TIMED_OUT) means the saga unwound to CANCELLED.
    return workflowStatusName === "COMPLETED" ? TripStatus.SETTLED : TripStatus.CANCELLED;
}

/**
 * True when a failed Query legitimately means "the run is closed/gone or its
 * query handler is unavailable" — the only cases where falling back to a
 * terminal status from `describe()` is correct. A transient/other error must
 * NOT be collapsed into a terminal status (it is surfaced as `Unavailable`).
 */
function isClosedOrMissingRun(err: unknown): boolean {
    return err instanceof WorkflowNotFoundError || err instanceof QueryNotRegisteredError || err instanceof QueryRejectedError;
}

/**
 * Build the TripService definition with an injected Temporal client.
 *
 * @param options - {@link TripServiceOptions}.
 */
export function createTripService(options: TripServiceOptions): ServiceDefinition {
    const { workflowClient, taskQueue } = options;

    return defineService(TripService, {
        async startTrip(req, ctx) {
            // SYNCHRONOUS availability pre-check — preserves today's edge error
            // contract. An unknown vehicle throws Code.NotFound inside
            // FleetService and propagates unchanged; an unavailable one is
            // rejected here as Code.FailedPrecondition. This runs BEFORE any
            // Temporal use, so the error-path e2e needs no live Temporal.
            const vehicle = await ctx.call("fleet.v1.FleetService/GetVehicle", create(GetVehicleRequestSchema, { id: req.vehicleId }));

            if (vehicle.vehicle?.available !== true) {
                throw new ConnectError(`Vehicle "${req.vehicleId}" is not available.`, Code.FailedPrecondition);
            }

            if (workflowClient === undefined) {
                throw new ConnectError("Temporal is not configured — cannot start the trip workflow.", Code.Unavailable);
            }

            const tripId = `trip-${randomUUID()}`;

            // Start the durable saga (fire-and-forget; the handle returns
            // immediately). The workflow id IS the trip id, so GetTrip can map
            // a trip id straight to its workflow.
            const handle = await workflowClient.start("TripWorkflow", {
                taskQueue,
                workflowId: tripId,
                args: [{ userId: req.userId, vehicleId: req.vehicleId, tripId }],
            });

            return create(StartTripResponseSchema, {
                trip: create(TripSchema, { id: tripId, status: TripStatus.STARTED }),
                workflowId: handle.workflowId,
            });
        },

        async getTrip(req) {
            if (workflowClient === undefined) {
                throw new ConnectError("Temporal is not configured — cannot read trip status.", Code.Unavailable);
            }

            const handle = workflowClient.getHandle(req.tripId);

            // Prefer the LIVE status from the running workflow's Query. Only when
            // the Query is unavailable because the run is closed/gone or its
            // query handler isn't registered do we fall back to a terminal status
            // derived from describe(). A transient/other failure is surfaced as
            // Unavailable, never silently mapped to a terminal status.
            let status: TripStatusT;
            try {
                status = await handle.query<TripStatusT>("getTripStatus");
            } catch (err) {
                if (!isClosedOrMissingRun(err)) {
                    throw new ConnectError(`Could not read status for trip "${req.tripId}".`, Code.Unavailable);
                }
                const description = await handle.describe();
                status = terminalStatusFor(description.status.name);
            }

            return create(GetTripResponseSchema, {
                trip: create(TripSchema, { id: req.tripId, status }),
            });
        },

        // INTERNAL — called by the worker's reserve→record activity. Creates the
        // trip ledger row (status STARTED). Idempotent by trip id.
        recordTrip(req) {
            const existing = trips.get(req.tripId);
            if (existing === undefined) {
                trips.set(req.tripId, { id: req.tripId, userId: req.userId, vehicleId: req.vehicleId, status: TripStatus.STARTED });
            }
            const record = trips.get(req.tripId);
            return create(RecordTripResponseSchema, { trip: create(TripSchema, { id: req.tripId, status: record?.status ?? TripStatus.STARTED }) });
        },

        // INTERNAL — called by the worker's end / cancel activities. Transitions
        // the trip to a terminal status (ENDED on finish, CANCELLED as the
        // record-trip compensation). Idempotent: re-applying the same terminal
        // status is a no-op; CANCELLED always wins over a prior ENDED (the saga
        // rolled back).
        endTrip(req) {
            const record = trips.get(req.tripId);
            const target: TripStatusT = req.status === TripStatus.CANCELLED ? TripStatus.CANCELLED : TripStatus.ENDED;
            if (record !== undefined) {
                // CANCELLED is terminal-dominant; never downgrade it back to ENDED.
                if (record.status !== TripStatus.CANCELLED) {
                    record.status = target;
                }
            }
            return create(EndTripResponseSchema, { trip: create(TripSchema, { id: req.tripId, status: record?.status ?? target }) });
        },
    });
}
