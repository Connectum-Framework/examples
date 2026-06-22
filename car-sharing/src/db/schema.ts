/**
 * Drizzle schema — the fleet's `vehicles` table (Phase 1 persistence).
 *
 * FleetService is the only service backed by a real database. The table is the
 * vehicle system of record: a row per vehicle with its model, availability,
 * lifecycle `status`, last-known location, and an `updatedAt` audit column.
 *
 * `status` is a free-text column whose domain is pinned in code by
 * {@link VehicleStatus} (proto models it as a plain string; see fleet.proto for
 * why a native proto enum is avoided under `erasableSyntaxOnly`). The invariant
 * the service maintains is `available <=> status === "available"`.
 *
 * @module db/schema
 */

import { boolean, doublePrecision, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Vehicle lifecycle states. A `const` object (no `enum` under erasable TypeScript) — the string
 * domain stored in {@link vehicles}.`status`.
 */
export const VehicleStatus = {
    AVAILABLE: "available",
    RESERVED: "reserved",
    MAINTENANCE: "maintenance",
} as const;

/** One of the {@link VehicleStatus} string values. */
export type VehicleStatus = (typeof VehicleStatus)[keyof typeof VehicleStatus];

/**
 * `vehicles` — the fleet system of record.
 *
 *  - `id`        text primary key (e.g. `v-001`).
 *  - `model`     human-readable model name.
 *  - `available` derived boolean, kept in sync with `status`.
 *  - `status`    {@link VehicleStatus} string.
 *  - `lat`/`lng` last-known position (nullable; double precision so it maps to
 *                the proto `double` location fields without string coercion).
 *  - `updatedAt` last mutation timestamp (defaults to now()).
 */
export const vehicles = pgTable("vehicles", {
    id: text("id").primaryKey(),
    model: text("model").notNull(),
    available: boolean("available").notNull(),
    status: text("status").notNull(),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A selected `vehicles` row. */
export type VehicleRow = typeof vehicles.$inferSelect;
/** An insertable `vehicles` row. */
export type NewVehicleRow = typeof vehicles.$inferInsert;
