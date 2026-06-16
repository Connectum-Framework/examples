/**
 * FleetService — the vehicle system of record (a leaf service).
 *
 * Defined with `defineService`: handlers receive a Connectum `ctx`, but this
 * service makes no cross-service calls of its own. It owns an in-memory vehicle
 * map and returns `Code.NotFound` for an unknown id.
 *
 * Internal-only: reached by the trip handler via `ctx.call`, never by external
 * clients. Its proto marks every method `public` so the gateway auth/authz
 * interceptors skip it (an internal `ctx.call` carries no Authorization header).
 *
 * @module services/fleetService
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import { FleetService, GetVehicleResponseSchema, VehicleSchema } from "#gen/fleet/v1/fleet_pb.ts";

/** Seed vehicles (id → [model, available]). */
const VEHICLES: ReadonlyArray<readonly [string, readonly [string, boolean]]> = [
    ["v-001", ["Tesla Model 3", true]],
    ["v-002", ["Renault Zoe", true]],
    ["v-003", ["VW ID.3", false]], // in maintenance — unavailable
];

/** Demo vehicle fleet (id → Vehicle fields). */
const vehicles = new Map<string, { model: string; available: boolean }>(VEHICLES.map(([id, [model, available]]) => [id, { model, available }]));

export const fleetService = defineService(FleetService, {
    getVehicle: (req) => {
        const vehicle = vehicles.get(req.id);
        if (vehicle === undefined) {
            throw new ConnectError(`No vehicle with id "${req.id}".`, Code.NotFound);
        }
        return create(GetVehicleResponseSchema, {
            vehicle: create(VehicleSchema, { id: req.id, model: vehicle.model, available: vehicle.available }),
        });
    },
});
