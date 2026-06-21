/**
 * Drizzle client factory — the app's Postgres connection.
 *
 * Production/dev connect over postgres.js to `DATABASE_URL` (the docker-compose
 * Postgres). The service does NOT import this directly: `buildServer` injects a
 * `Db` into `createDirectoryService`, so tests can pass a PGlite-backed Drizzle
 * db (an in-process Postgres) instead — no Docker needed for the e2e.
 *
 * The exported {@link Db} type is the common supertype of BOTH drivers'
 * databases (postgres.js and PGlite both extend `PgDatabase`), so either can be
 * injected wherever a `Db` is expected.
 *
 * @module db/client
 */

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "#db/schema.ts";

/**
 * Driver-agnostic Drizzle database type bound to the app schema.
 *
 * Both `drizzle-orm/postgres-js` and `drizzle-orm/pglite` return subclasses of
 * `PgDatabase`, so typing against the base lets the test inject a PGlite db and
 * the server inject a postgres.js db through the same `Db` parameter.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Create a Drizzle client over postgres.js from a connection URL.
 *
 * postgres.js connects lazily (no socket is opened until the first query), so
 * constructing this in monolith/test mode where the directory db is overridden
 * is harmless — the default connection is never used.
 *
 * @param url - Postgres connection string; defaults to `DATABASE_URL`.
 */
export function createDb(url: string | undefined = process.env.DATABASE_URL): Db {
    if (url === undefined || url === "") {
        throw new Error("DATABASE_URL is not set — cannot create the directory database client. " + "Set DATABASE_URL (see docker-compose.yml) or inject a Db (tests use PGlite).");
    }
    return drizzle(url, { schema });
}
