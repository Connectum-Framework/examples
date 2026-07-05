/**
 * DirectoryService — the employee system of record, now backed by Drizzle +
 * Postgres.
 *
 * This is the only persistent service (Phase 1). It is built by a factory,
 * `createDirectoryService(db)`, so the database is injected: `buildServer`
 * passes a postgres.js-backed Drizzle db in production, while the e2e injects a
 * PGlite (in-process Postgres) db through the same parameter — no Docker for
 * tests.
 *
 * Handlers map SQL rows to the `Employee` proto message.
 *
 *  - GetEmployee   — point read; NOT_FOUND on unknown id. Returns the full
 *                    Employee, including the org-chart `managerId` and `status`.
 *                    Reached by the TimeOff handler via `ctx.call` to validate
 *                    that an employee exists before approving a leave request.
 *  - ListEmployees — server-streaming: a `where`/`order by id`/`limit` query
 *                    with cursor pagination (the caller re-sends the last
 *                    streamed id as `page_token`), optionally filtered by
 *                    `department` and/or `managerId` — the latter being the
 *                    org-chart "direct reports of this manager" query.
 *
 * This service makes no cross-service calls of its own (a leaf service).
 *
 * @module services/directoryService
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import type { ServiceDefinition } from "@connectum/core";
import { and, asc, eq, gt } from "drizzle-orm";
import { ActivateEmployeeResponseSchema, CreateEmployeeResponseSchema, DirectoryService, EmployeeSchema, GetEmployeeResponseSchema, OffboardEmployeeResponseSchema } from "#gen/directory/v1/directory_pb.ts";
import type { Employee } from "#gen/directory/v1/directory_pb.ts";
import { employees, EmployeeStatus } from "#db/schema.ts";
import type { Db } from "#db/client.ts";
import type { EmployeeRow } from "#db/schema.ts";

/** Default page size for ListEmployees when the request asks for 0 / negative. */
const DEFAULT_PAGE_SIZE = 20;
/** Hard cap on page size so a client cannot stream an unbounded page. */
const MAX_PAGE_SIZE = 100;

/**
 * Map an `employees` row to the wire `Employee` message.
 *
 * A null `managerId` (the top of the org chart) maps to an empty string — proto3
 * scalar strings have no null, and the proto comments document empty as "no
 * manager".
 */
function toEmployee(row: EmployeeRow): Employee {
    return create(EmployeeSchema, {
        id: row.id,
        name: row.name,
        department: row.department,
        email: row.email,
        title: row.title,
        managerId: row.managerId ?? "",
        status: row.status,
    });
}

/** Clamp a requested page size into `[1, MAX_PAGE_SIZE]`. */
function clampPageSize(pageSize: number): number {
    if (pageSize <= 0) return DEFAULT_PAGE_SIZE;
    return Math.min(pageSize, MAX_PAGE_SIZE);
}

/**
 * Build the DirectoryService definition over an injected Drizzle db.
 *
 * @param db - Drizzle database (postgres.js in prod, PGlite in tests).
 */
export function createDirectoryService(db: Db): ServiceDefinition {
    return defineService(DirectoryService, {
        async getEmployee(req) {
            const rows = await db.select().from(employees).where(eq(employees.id, req.id)).limit(1);
            const row = rows[0];
            if (row === undefined) {
                throw new ConnectError(`No employee with id "${req.id}".`, Code.NotFound);
            }
            return create(GetEmployeeResponseSchema, { employee: toEmployee(row) });
        },

        async *listEmployees(req) {
            const limit = clampPageSize(req.pageSize);

            // Cursor pagination over a stable `order by id`: the client re-sends
            // the last streamed id as page_token to fetch the next page. The
            // department / managerId filters narrow the stream — managerId is the
            // org-chart "direct reports of this manager" query. An empty filter
            // string means "no filter" (same convention as page_token).
            const cursor = req.pageToken !== "" ? gt(employees.id, req.pageToken) : undefined;
            const departmentFilter = req.department !== "" ? eq(employees.department, req.department) : undefined;
            const managerFilter = req.managerId !== "" ? eq(employees.managerId, req.managerId) : undefined;
            const where = and(cursor, departmentFilter, managerFilter);

            const rows = await db.select().from(employees).where(where).orderBy(asc(employees.id)).limit(limit);

            for (const row of rows) {
                yield toEmployee(row);
            }
        },

        // ── Onboarding saga RPCs (driven by the Temporal worker's activities) ──

        // Step 1 — insert a new employee in "onboarding" status. Uses an ATOMIC
        // `insert ... on conflict do nothing returning`: an empty result means
        // the id was already taken, surfaced as Code.AlreadyExists (race-free,
        // and never leaking a raw DB unique-violation). The workflow treats this
        // business failure as non-retryable.
        async createEmployee(req) {
            const inserted = await db
                .insert(employees)
                .values({
                    id: req.id,
                    name: req.name,
                    email: req.email,
                    title: req.title,
                    department: req.department,
                    managerId: req.managerId !== "" ? req.managerId : null,
                    status: EmployeeStatus.ONBOARDING,
                })
                .onConflictDoNothing()
                .returning();

            const row = inserted[0];
            if (row === undefined) {
                throw new ConnectError(`Employee with id "${req.id}" already exists.`, Code.AlreadyExists);
            }
            return create(CreateEmployeeResponseSchema, { employee: toEmployee(row) });
        },

        // Terminal step — flip "onboarding" → "active". Idempotent: re-activating
        // an already-active employee returns the same row. NOT_FOUND for an
        // unknown id (in-saga this never happens — activation follows creation).
        async activateEmployee(req) {
            const updated = await db.update(employees).set({ status: EmployeeStatus.ACTIVE, updatedAt: new Date() }).where(eq(employees.id, req.id)).returning();
            const row = updated[0];
            if (row === undefined) {
                throw new ConnectError(`No employee with id "${req.id}".`, Code.NotFound);
            }
            return create(ActivateEmployeeResponseSchema, { employee: toEmployee(row) });
        },

        // Compensation for step 1 — mark "offboarded". Idempotent: a no-op
        // success for an unknown id (the saga only offboards a row it created,
        // so this defends against a double unwind).
        async offboardEmployee(req) {
            const updated = await db.update(employees).set({ status: EmployeeStatus.OFFBOARDED, updatedAt: new Date() }).where(eq(employees.id, req.id)).returning();
            const row = updated[0];
            const employee = row !== undefined ? toEmployee(row) : create(EmployeeSchema, { id: req.id, status: EmployeeStatus.OFFBOARDED });
            return create(OffboardEmployeeResponseSchema, { employee });
        },
    });
}
