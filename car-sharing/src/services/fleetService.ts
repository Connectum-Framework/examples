/**
 * FleetService — the vehicle system of record, now backed by Drizzle + Postgres.
 *
 * This is the only persistent service (Phase 1). It is built by a factory,
 * `createFleetService(db)`, so the database is injected: `buildServer` passes a
 * postgres.js-backed Drizzle db in production, while the e2e injects a PGlite
 * (in-process Postgres) db through the same parameter — no Docker for tests.
 *
 * Handlers map SQL rows to the `Vehicle` proto message. The invariant kept
 * across mutations is `available <=> status === "available"`.
 *
 *  - GetVehicle     — point read; NOT_FOUND on unknown id. Still returns
 *                     `Vehicle.available`, which the trip handler depends on.
 *  - ListVehicles   — server-streaming: a `where`/`order by id`/`limit` query
 *                     with cursor pagination (the caller re-sends the last
 *                     streamed id as `page_token`), optionally filtered to
 *                     available vehicles.
 *  - ReserveVehicle — atomic `UPDATE ... WHERE id=? AND available=true`;
 *                     NOT_FOUND on unknown id, FAILED_PRECONDITION when already
 *                     reserved / in maintenance.
 *  - ReleaseVehicle — returns a vehicle to the available pool; NOT_FOUND on
 *                     unknown id, FAILED_PRECONDITION when in maintenance.
 *
 * Internal-only and `public` in proto: reached by the trip handler via
 * `ctx.call`, never by external clients (see fleet.proto).
 *
 * @module services/fleetService
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import type { ServiceDefinition } from "@connectum/core";
import { and, asc, eq, gt } from "drizzle-orm";
import { FleetService, GetVehicleResponseSchema, LocationSchema, VehicleSchema } from "#gen/fleet/v1/fleet_pb.ts";
import type { Vehicle } from "#gen/fleet/v1/fleet_pb.ts";
import { VehicleStatus, vehicles } from "#db/schema.ts";
import type { Db } from "#db/client.ts";
import type { VehicleRow } from "#db/schema.ts";

/** Default page size for ListVehicles when the request asks for 0 / negative. */
const DEFAULT_PAGE_SIZE = 20;
/** Hard cap on page size so a client cannot stream an unbounded page. */
const MAX_PAGE_SIZE = 100;

/** Map a `vehicles` row to the wire `Vehicle` message. */
function toVehicle(row: VehicleRow): Vehicle {
    const location = row.lat !== null && row.lng !== null ? create(LocationSchema, { lat: row.lat, lng: row.lng }) : undefined;
    return create(VehicleSchema, {
        id: row.id,
        model: row.model,
        available: row.available,
        status: row.status,
        location,
    });
}

/** Clamp a requested page size into `[1, MAX_PAGE_SIZE]`. */
function clampPageSize(pageSize: number): number {
    if (pageSize <= 0) return DEFAULT_PAGE_SIZE;
    return Math.min(pageSize, MAX_PAGE_SIZE);
}

/**
 * Build the FleetService definition over an injected Drizzle db.
 *
 * @param db - Drizzle database (postgres.js in prod, PGlite in tests).
 */
export function createFleetService(db: Db): ServiceDefinition {
    return defineService(FleetService, {
        async getVehicle(req) {
            const rows = await db.select().from(vehicles).where(eq(vehicles.id, req.id)).limit(1);
            const row = rows[0];
            if (row === undefined) {
                throw new ConnectError(`No vehicle with id "${req.id}".`, Code.NotFound);
            }
            return create(GetVehicleResponseSchema, { vehicle: toVehicle(row) });
        },

        async *listVehicles(req) {
            const limit = clampPageSize(req.pageSize);

            // Cursor pagination over a stable `order by id`: the client re-sends
            // the last streamed id as page_token to fetch the next page. The
            // available_only filter narrows to currently-available vehicles.
            const cursor = req.pageToken !== "" ? gt(vehicles.id, req.pageToken) : undefined;
            const availableFilter = req.availableOnly ? eq(vehicles.available, true) : undefined;
            const where = and(cursor, availableFilter);

            const rows = await db.select().from(vehicles).where(where).orderBy(asc(vehicles.id)).limit(limit);

            for (const row of rows) {
                yield toVehicle(row);
            }
        },

        async reserveVehicle(req) {
            // Atomic reserve: only flips a vehicle that is currently available,
            // stamping the holder (the trip/workflow id). An empty result means
            // either the id is unknown OR it was not available — a follow-up read
            // disambiguates the error code AND the idempotent-retry case below.
            const updated = await db
                .update(vehicles)
                .set({ available: false, status: VehicleStatus.RESERVED, holder: req.holderId, updatedAt: new Date() })
                .where(and(eq(vehicles.id, req.id), eq(vehicles.available, true)))
                .returning();

            const row = updated[0];
            if (row !== undefined) {
                return toVehicle(row);
            }

            const existing = await db.select().from(vehicles).where(eq(vehicles.id, req.id)).limit(1);
            const current = existing[0];
            if (current === undefined) {
                throw new ConnectError(`No vehicle with id "${req.id}".`, Code.NotFound);
            }
            // Idempotent retry: the SAME holder re-reserving its own vehicle (a
            // Temporal retry that observed its prior commit) succeeds. A held
            // vehicle with a different (or empty) holder is a genuine conflict.
            if (req.holderId !== "" && current.holder === req.holderId) {
                return toVehicle(current);
            }
            throw new ConnectError(`Vehicle "${req.id}" is not available (status "${current.status}").`, Code.FailedPrecondition);
        },

        async releaseVehicle(req) {
            const existing = await db.select().from(vehicles).where(eq(vehicles.id, req.id)).limit(1);
            const current = existing[0];
            if (current === undefined) {
                throw new ConnectError(`No vehicle with id "${req.id}".`, Code.NotFound);
            }
            // A vehicle in maintenance cannot be released back into service via
            // the fleet API — that is an operational decision, not a release.
            if (current.status === VehicleStatus.MAINTENANCE) {
                throw new ConnectError(`Vehicle "${req.id}" is in maintenance and cannot be released.`, Code.FailedPrecondition);
            }

            const updated = await db
                .update(vehicles)
                .set({ available: true, status: VehicleStatus.AVAILABLE, holder: null, updatedAt: new Date() })
                .where(eq(vehicles.id, req.id))
                .returning();

            return toVehicle(updated[0] as VehicleRow);
        },
    });
}
