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
import { DirectoryService, EmployeeSchema, GetEmployeeResponseSchema } from "#gen/directory/v1/directory_pb.ts";
import type { Employee } from "#gen/directory/v1/directory_pb.ts";
import { employees } from "#db/schema.ts";
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
    });
}
