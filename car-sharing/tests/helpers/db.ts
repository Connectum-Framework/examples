/**
 * Test database helper — an in-process Postgres for the e2e, no Docker.
 *
 * Builds a fresh PGlite-backed Drizzle db, applies the SAME drizzle-kit
 * migrations the app uses against real Postgres (single source of truth — no
 * hand-written DDL that could drift from `src/db/schema.ts`), and seeds it with
 * the shared {@link seedVehicles} data so the fleet matches what the existing
 * trip/billing e2e and the new fleet e2e expect.
 *
 * The returned `Db` is injected into `buildServer({ db })`, the same parameter
 * production uses for its postgres.js client.
 *
 * @module tests/helpers/db
 */

import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "#db/client.ts";
import * as schema from "#db/schema.ts";
import { seedVehicles } from "#db/seed.ts";

/** Absolute path to the committed drizzle-kit migrations folder. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Create a migrated, seeded PGlite-backed Drizzle db for tests.
 *
 * Each call spins up an isolated in-memory Postgres, so test files do not share
 * state. Re-seed within a file (e.g. in `beforeEach`) via {@link reseed} when a
 * test mutates rows.
 */
export async function makeTestDb(): Promise<Db> {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await seedVehicles(db);
    return db;
}

/** Reset the fleet to the seed state (used between tests that mutate rows). */
export async function reseed(db: Db): Promise<void> {
    await seedVehicles(db);
}
