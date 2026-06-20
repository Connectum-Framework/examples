/**
 * drizzle-kit config — generates SQL migrations from `src/db/schema.ts` and
 * pushes/applies them to the Postgres at `DATABASE_URL`.
 *
 *  - `pnpm db:generate` writes versioned SQL into `drizzle/` (committed). Those
 *    migrations are applied by `pnpm db:migrate` (docker-compose / prod) and by
 *    the e2e PGlite migrator — same files, one source of truth.
 *  - `pnpm db:push` is a dev convenience that diff-syncs `schema.ts` to the DB
 *    without going through the migration files.
 *
 * @module drizzle.config
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "postgresql",
    schema: "./src/db/schema.ts",
    out: "./drizzle",
    dbCredentials: {
        url: process.env.DATABASE_URL ?? "postgresql://car_sharing:car_sharing@localhost:5432/car_sharing",
    },
});
