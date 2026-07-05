/**
 * E2E tests — DirectoryService over Drizzle + PGlite (Phase 1 persistence).
 *
 * The directory is the only persistent service: a PGlite in-process Postgres is
 * migrated + seeded in the test and injected into `buildServer({ db })`, the
 * same parameter production uses for its postgres.js client. Every assertion
 * goes through a REAL gRPC client over HTTP/2 (the server runs
 * `allowHTTP1: false`), exercising the actual wire path — not the db directly.
 *
 * Unlike car-sharing's fleet e2e, this suite ALSO injects a `MemoryAdapter`
 * EventBus: `buildServer` builds a bus for every role and the payroll subscriber
 * is registered in the monolith, so without an in-memory adapter `server.start()`
 * would try to connect to NATS (the default adapter) and hang. The bus is not
 * exercised here — it is injected only so the server starts without a broker.
 *
 * Covered:
 *  - GetEmployee: point read returns the persisted Employee (incl. email, title,
 *    managerId, status); unknown id → NOT_FOUND.
 *  - ListEmployees (server-streaming): the unfiltered stream returns all seeds in
 *    id order; the `department` filter narrows to a department; the `manager_id`
 *    filter is the org-chart "direct reports of this manager" query; cursor
 *    pagination (page_size + page_token) walks pages; combined filters compose.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Client } from "@connectrpc/connect";
import type { Server } from "@connectum/core";
import { MemoryAdapter } from "@connectum/events";
import { DirectoryService, GetEmployeeRequestSchema, ListEmployeesRequestSchema } from "#gen/directory/v1/directory_pb.ts";
import type { Employee } from "#gen/directory/v1/directory_pb.ts";
import { buildEventBus } from "#eventBus.ts";
import { buildServer } from "#server.ts";
import type { Db } from "#db/client.ts";
import { resolveTopology } from "#topology.ts";
import { makeTestDb } from "../helpers/db.ts";

/** Drain a server-streaming response into an array. */
async function collect(stream: AsyncIterable<Employee>): Promise<Employee[]> {
    const out: Employee[] = [];
    for await (const e of stream) out.push(e);
    return out;
}

describe("E2E: DirectoryService persistence (Drizzle + PGlite, real gRPC client)", () => {
    let server: Server;
    let db: Db;
    let directory: Client<typeof DirectoryService>;

    before(async () => {
        // Monolith topology, a PGlite-backed Drizzle db (no Docker), and an
        // in-memory EventBus so the server starts without a NATS broker.
        const topology = resolveTopology("*");
        db = await makeTestDb();
        const eventBus = buildEventBus({ localTypeNames: topology.localTypeNames, adapter: MemoryAdapter() });
        server = buildServer({ port: 0, topology, eventBus, db });
        await server.start();
        const port = server.address?.port ?? 0;
        directory = createClient(DirectoryService, createGrpcTransport({ baseUrl: `http://localhost:${port}` }));
    });

    after(async () => {
        if (server.state === "running") await server.stop();
    });

    it("GetEmployee returns the persisted employee with all fields", async () => {
        const res = await directory.getEmployee(create(GetEmployeeRequestSchema, { id: "e-002" }));
        assert.equal(res.employee?.id, "e-002");
        assert.equal(res.employee?.name, "Grace Hopper");
        assert.equal(res.employee?.department, "Engineering");
        assert.equal(res.employee?.email, "grace@example.com");
        assert.equal(res.employee?.title, "Engineering Manager");
        assert.equal(res.employee?.managerId, "e-001");
        assert.equal(res.employee?.status, "active");
    });

    it("GetEmployee on the CEO returns an empty manager_id (top of the org chart)", async () => {
        const res = await directory.getEmployee(create(GetEmployeeRequestSchema, { id: "e-001" }));
        assert.equal(res.employee?.id, "e-001");
        assert.equal(res.employee?.name, "Ada Lovelace");
        assert.equal(res.employee?.managerId, "");
        assert.equal(res.employee?.status, "active");
    });

    it("GetEmployee surfaces an onboarding status", async () => {
        const res = await directory.getEmployee(create(GetEmployeeRequestSchema, { id: "e-005" }));
        assert.equal(res.employee?.id, "e-005");
        assert.equal(res.employee?.status, "onboarding");
    });

    it("GetEmployee on an unknown id is NOT_FOUND", async () => {
        await assert.rejects(
            directory.getEmployee(create(GetEmployeeRequestSchema, { id: "ghost" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.NotFound,
        );
    });

    it("ListEmployees streams every seeded employee in id order (no filter)", async () => {
        const all = await collect(directory.listEmployees(create(ListEmployeesRequestSchema, {})));
        assert.equal(all.length, 7);
        assert.deepEqual(
            all.map((e) => e.id),
            ["e-001", "e-002", "e-003", "e-004", "e-005", "e-006", "e-007"],
        );
    });

    it("ListEmployees filters by department", async () => {
        const eng = await collect(directory.listEmployees(create(ListEmployeesRequestSchema, { department: "Engineering" })));
        assert.deepEqual(
            eng.map((e) => e.id),
            ["e-001", "e-002", "e-004", "e-005"],
        );
        assert.ok(eng.every((e) => e.department === "Engineering"));

        const finance = await collect(directory.listEmployees(create(ListEmployeesRequestSchema, { department: "Finance" })));
        assert.deepEqual(
            finance.map((e) => e.id),
            ["e-003", "e-006", "e-007"],
        );
    });

    it("ListEmployees filters by manager_id (org-chart direct reports)", async () => {
        // Grace Hopper's direct reports.
        const graceReports = await collect(directory.listEmployees(create(ListEmployeesRequestSchema, { managerId: "e-002" })));
        assert.deepEqual(
            graceReports.map((e) => e.id),
            ["e-004", "e-005"],
        );
        assert.ok(graceReports.every((e) => e.managerId === "e-002"));

        // The CEO's direct reports (the two managers).
        const ceoReports = await collect(directory.listEmployees(create(ListEmployeesRequestSchema, { managerId: "e-001" })));
        assert.deepEqual(
            ceoReports.map((e) => e.id),
            ["e-002", "e-003"],
        );
    });

    it("ListEmployees paginates with page_size + page_token (cursor over the stream)", async () => {
        // Page 1 — first three by id.
        const page1 = await collect(directory.listEmployees(create(ListEmployeesRequestSchema, { pageSize: 3 })));
        assert.deepEqual(
            page1.map((e) => e.id),
            ["e-001", "e-002", "e-003"],
        );

        // Page 2 — cursor = last streamed id of page 1.
        const cursor = page1[page1.length - 1]?.id ?? "";
        const page2 = await collect(directory.listEmployees(create(ListEmployeesRequestSchema, { pageSize: 3, pageToken: cursor })));
        assert.deepEqual(
            page2.map((e) => e.id),
            ["e-004", "e-005", "e-006"],
        );

        // Page 3 — the remainder (fewer than page_size).
        const cursor2 = page2[page2.length - 1]?.id ?? "";
        const page3 = await collect(directory.listEmployees(create(ListEmployeesRequestSchema, { pageSize: 3, pageToken: cursor2 })));
        assert.deepEqual(
            page3.map((e) => e.id),
            ["e-007"],
        );
    });

    it("ListEmployees combines the department and manager_id filters", async () => {
        // Engineering employees who report directly to Grace Hopper (e-002).
        const combined = await collect(directory.listEmployees(create(ListEmployeesRequestSchema, { department: "Engineering", managerId: "e-002" })));
        assert.deepEqual(
            combined.map((e) => e.id),
            ["e-004", "e-005"],
        );
        assert.ok(combined.every((e) => e.department === "Engineering" && e.managerId === "e-002"));
    });

    it("ListEmployees combines a filter with cursor pagination", async () => {
        // Engineering in id order: e-001, e-002, e-004, e-005.
        const page1 = await collect(directory.listEmployees(create(ListEmployeesRequestSchema, { department: "Engineering", pageSize: 2 })));
        assert.deepEqual(
            page1.map((e) => e.id),
            ["e-001", "e-002"],
        );

        const cursor = page1[page1.length - 1]?.id ?? "";
        const page2 = await collect(directory.listEmployees(create(ListEmployeesRequestSchema, { department: "Engineering", pageSize: 2, pageToken: cursor })));
        // The cursor skips past e-003 (Finance) — the filter + cursor compose.
        assert.deepEqual(
            page2.map((e) => e.id),
            ["e-004", "e-005"],
        );
    });
});
