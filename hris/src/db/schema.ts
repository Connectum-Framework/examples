/**
 * Drizzle schema — the directory's `employees` table (Phase 1 persistence).
 *
 * DirectoryService is the only service backed by a real database. The table is
 * the employee system of record: a row per employee with their name, work
 * email, job title, department, the id of their manager (an org-chart edge),
 * employment lifecycle `status`, and an `updatedAt` audit column.
 *
 * `status` is a free-text column whose domain is pinned in code by
 * {@link EmployeeStatus} (proto models it as a plain string; see directory.proto
 * for why a native proto enum is avoided under `erasableSyntaxOnly`).
 *
 * `managerId` is a plain nullable text column that references another row's
 * `id` (the CEO has `managerId = null`). It is intentionally modeled WITHOUT a
 * DB-level foreign-key constraint, to keep the generated migration simple — the
 * org chart is a self-referencing edge enforced by the seed data, not by the DB.
 *
 * @module db/schema
 */

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Employment lifecycle states. A `const` object (ADR-001: no `enum`) — the
 * string domain stored in {@link employees}.`status`.
 */
export const EmployeeStatus = {
    ACTIVE: "active",
    ONBOARDING: "onboarding",
    OFFBOARDED: "offboarded",
} as const;

/** One of the {@link EmployeeStatus} string values. */
export type EmployeeStatus = (typeof EmployeeStatus)[keyof typeof EmployeeStatus];

/**
 * `employees` — the directory system of record.
 *
 *  - `id`         text primary key (e.g. `e-001`).
 *  - `name`       full name.
 *  - `email`      work email address.
 *  - `title`      job title (e.g. "Staff Engineer").
 *  - `department` department name.
 *  - `managerId`  the id of this employee's manager (nullable — null for the top
 *                 of the org chart, e.g. the CEO). A plain text column, NOT a
 *                 DB-level FK, so the migration stays simple.
 *  - `status`     {@link EmployeeStatus} string.
 *  - `updatedAt`  last mutation timestamp (defaults to now()).
 */
export const employees = pgTable("employees", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    title: text("title").notNull(),
    department: text("department").notNull(),
    managerId: text("manager_id"),
    status: text("status").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A selected `employees` row. */
export type EmployeeRow = typeof employees.$inferSelect;
/** An insertable `employees` row. */
export type NewEmployeeRow = typeof employees.$inferInsert;
