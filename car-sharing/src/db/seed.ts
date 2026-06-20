/**
 * Seed data + seeding routine for the fleet `vehicles` table.
 *
 * The first three rows reproduce the original in-memory fleet so the existing
 * trip/billing flows keep working unchanged:
 *   - v-001 Tesla Model 3   — available
 *   - v-002 Renault Zoe     — available
 *   - v-003 VW ID.3         — maintenance (unavailable)
 * A few more available/reserved vehicles follow so `ListVehicles` pagination and
 * the `available_only` filter are demonstrable.
 *
 * `seedVehicles(db)` is idempotent-ish for demos: it deletes existing rows then
 * inserts the seed set, so re-running (`pnpm db:seed`) or re-seeding between
 * tests yields a known state. Reused by both the CLI script (bottom of file) and
 * the e2e test helper.
 *
 * @module db/seed
 */

import { VehicleStatus, vehicles } from "#db/schema.ts";
import type { Db } from "#db/client.ts";
import type { NewVehicleRow } from "#db/schema.ts";

/** The demo fleet. `available` is kept in sync with `status` per the invariant. */
export const SEED_VEHICLES: ReadonlyArray<NewVehicleRow> = [
    { id: "v-001", model: "Tesla Model 3", status: VehicleStatus.AVAILABLE, available: true, lat: 52.5200, lng: 13.4050 },
    { id: "v-002", model: "Renault Zoe", status: VehicleStatus.AVAILABLE, available: true, lat: 52.5170, lng: 13.3889 },
    { id: "v-003", model: "VW ID.3", status: VehicleStatus.MAINTENANCE, available: false, lat: 52.4900, lng: 13.4200 },
    { id: "v-004", model: "BMW i3", status: VehicleStatus.AVAILABLE, available: true, lat: 52.5300, lng: 13.3850 },
    { id: "v-005", model: "Hyundai Ioniq 5", status: VehicleStatus.AVAILABLE, available: true, lat: 52.5450, lng: 13.3550 },
    { id: "v-006", model: "Nissan Leaf", status: VehicleStatus.RESERVED, available: false, lat: 52.5060, lng: 13.4300 },
    { id: "v-007", model: "Polestar 2", status: VehicleStatus.AVAILABLE, available: true, lat: 52.5100, lng: 13.4500 },
];

/**
 * Replace the fleet with the {@link SEED_VEHICLES} set.
 *
 * @param db - Drizzle db (postgres.js in prod, PGlite in tests).
 */
export async function seedVehicles(db: Db): Promise<void> {
    await db.delete(vehicles);
    await db.insert(vehicles).values([...SEED_VEHICLES]);
}

// CLI entrypoint: `pnpm db:seed`. Connects over postgres.js to DATABASE_URL,
// seeds, and exits. Guarded so importing this module (e.g. from the test helper)
// does NOT open a database connection.
if (import.meta.url === `file://${process.argv[1]}`) {
    const { createDb } = await import("#db/client.ts");
    const db = createDb();
    await seedVehicles(db);
    console.log(`Seeded ${SEED_VEHICLES.length} vehicles.`);
    process.exit(0);
}
