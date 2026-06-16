/**
 * TripService — the edge orchestrator, composing two framework primitives.
 *
 *  1. `ctx.call("fleet.v1.FleetService/GetVehicle", …)` checks the vehicle
 *     exists and is available. The transport is chosen by the framework:
 *     in-process when FleetService is mounted locally (monolith), or over the
 *     network via the `remoteResolver` when it lives in another pod (split) —
 *     the handler code is identical either way. A `Code.NotFound` from the fleet
 *     (unknown id) propagates straight back to the caller; an unavailable
 *     vehicle is rejected here as `Code.FailedPrecondition`.
 *  2. After reserving the vehicle, `ctx.call("billing.v1.BillingService/OpenTab",
 *     …)` opens the billing tab. Both calls are typed by the generated catalog.
 *
 * Authentication/authorization is NOT handled here — it is enforced by the
 * gateway interceptor chain (JWT auth + proto authz) declared in `server.ts`
 * and `trips.proto`. By the time this handler runs the caller is already
 * authenticated.
 *
 * @module services/tripService
 */

import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import { GetVehicleRequestSchema } from "#gen/fleet/v1/fleet_pb.ts";
import { OpenTabRequestSchema } from "#gen/billing/v1/billing_pb.ts";
import { StartTripResponseSchema, TripSchema, TripService } from "#gen/trips/v1/trips_pb.ts";

export const tripService = defineService(TripService, {
    async startTrip(req, ctx) {
        // Cross-service call #1 — fleet availability check. An unknown vehicle
        // throws Code.NotFound inside FleetService; that ConnectError propagates
        // to the caller unchanged.
        const vehicle = await ctx.call("fleet.v1.FleetService/GetVehicle", create(GetVehicleRequestSchema, { id: req.vehicleId }));

        if (vehicle.vehicle?.available !== true) {
            throw new ConnectError(`Vehicle "${req.vehicleId}" is not available.`, Code.FailedPrecondition);
        }

        const tripId = `trip-${randomUUID()}`;

        // Cross-service call #2 — open the billing tab for the started trip.
        await ctx.call("billing.v1.BillingService/OpenTab", create(OpenTabRequestSchema, { tripId }));

        return create(StartTripResponseSchema, {
            trip: create(TripSchema, { id: tripId, status: "STARTED" }),
        });
    },
});
