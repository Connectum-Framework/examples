/**
 * Activity ↔ RPC wiring + compensation idempotency tests — DOCKERLESS.
 *
 * Runs the REAL activity bodies (via `MockActivityEnvironment`) against a REAL
 * in-process Connectum monolith (`buildServer({ port: 0 })`) — the same server
 * the e2e uses, with a PGlite-backed DirectoryService and the in-memory
 * Payroll/TimeOff/Access services. No Temporal cluster, no Docker. This proves:
 *
 *  - each forward activity calls its RPC and mutates the real service state
 *    (a new directory row, a payroll balance, a PTO grant, a provisioned
 *    account, and finally the active status);
 *  - createEmployee on an already-taken id throws a NON-RETRYABLE
 *    `ApplicationFailure(EmployeeExists)` — the workflow's fail-fast contract;
 *  - the compensating activities are IDEMPOTENT — running offboard / teardown /
 *    revoke twice (or on already-undone state) is a no-op success.
 *
 * The activities read endpoints from `*_ADDR`; this test points all four at the
 * one in-process monolith before any activity builds its (lazily cached) client.
 *
 * @module tests/activity/activities
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { Server } from "@connectum/core";
import { MemoryAdapter } from "@connectum/events";
import { ApplicationFailure } from "@temporalio/activity";
import { MockActivityEnvironment } from "@temporalio/testing";
import { buildEventBus } from "#eventBus.ts";
import { GetEmployeeRequestSchema, DirectoryService } from "#gen/directory/v1/directory_pb.ts";
import { GetBalanceRequestSchema, PayrollService } from "#gen/payroll/v1/payroll_pb.ts";
import { GrantTimeOffRequestSchema, RequestLeaveRequestSchema, TimeOffService } from "#gen/timeoff/v1/timeoff_pb.ts";
import { Code, ConnectError } from "@connectrpc/connect";
import { buildServer } from "#server.ts";
import { accessCount, isProvisioned, resetAccess } from "#services/accessService.ts";
import { resetBalances } from "#services/payrollService.ts";
import { resetGrants, timeOffGrant } from "#services/timeOffService.ts";
import * as activities from "#temporal/activities.ts";
import type { NewHire } from "#temporal/activities.ts";
import { resolveTopology } from "#topology.ts";
import { makeTestDb, reseed } from "../helpers/db.ts";

const env = new MockActivityEnvironment();

/** Run a real activity body inside a mocked Temporal Activity Context. */
function run<A extends unknown[], R>(fn: (...args: A) => Promise<R>, ...args: A): Promise<R> {
    return env.run(fn, ...args);
}

/** A new hire whose id is FREE in the seed (e-001..e-007 are taken). */
const HIRE: NewHire = {
    employeeId: "e-200",
    name: "New Hire",
    email: "newhire@example.com",
    title: "Software Engineer",
    department: "Engineering",
    managerId: "e-002",
};

describe("Activities: real RPC wiring + compensation idempotency (in-process monolith, PGlite)", () => {
    let server: Server;
    let db: Awaited<ReturnType<typeof makeTestDb>>;

    before(async () => {
        const topology = resolveTopology("*");
        db = await makeTestDb();
        // In-memory bus so the monolith starts without a NATS broker (the saga
        // activities never publish; payroll still mounts its subscriber route).
        const eventBus = buildEventBus({ localTypeNames: topology.localTypeNames, adapter: MemoryAdapter() });
        // Mount onboarding without a Temporal client (`null`): only the saga's
        // role-service activities are exercised here, never the workflow client.
        server = buildServer({ port: 0, topology, db, eventBus, workflowClient: null });
        await server.start();
        const port = server.address?.port ?? 0;
        const addr = `http://localhost:${port}`;
        // Point every activity client at the one in-process monolith. Set BEFORE
        // the first activity call, since activities cache their clients lazily.
        process.env.DIRECTORY_ADDR = addr;
        process.env.PAYROLL_ADDR = addr;
        process.env.TIMEOFF_ADDR = addr;
        process.env.ACCESS_ADDR = addr;
    });

    beforeEach(async () => {
        await reseed(db);
        resetBalances();
        resetGrants();
        resetAccess();
    });

    after(async () => {
        if (server.state === "running") await server.stop();
    });

    it("forward steps create the employee, payroll, PTO grant, access, then activate", async () => {
        const directory = server.localClient(DirectoryService);
        const payroll = server.localClient(PayrollService);

        // Step 1 — directory row created in "onboarding" status.
        await run(activities.createEmployee, HIRE);
        const created = await directory.getEmployee(create(GetEmployeeRequestSchema, { id: HIRE.employeeId }));
        assert.equal(created.employee?.status, "onboarding");
        assert.equal(created.employee?.name, "New Hire");

        // Step 2 — payroll enrollment (initial balance).
        await run(activities.setupPayroll, { employeeId: HIRE.employeeId });
        const balance = await payroll.getBalance(create(GetBalanceRequestSchema, { employeeId: HIRE.employeeId }));
        // The initial balance and the PTO allotment are the demo's own policy
        // numbers (no document fixes them); the wiring property is that a
        // positive number of days actually reaches the service.
        assert.equal(balance.balance?.employeeId, HIRE.employeeId);
        assert.ok((balance.balance?.remainingDays ?? 0) > 0, "the new hire is enrolled with a positive leave balance");

        // Step 3 — PTO policy grant recorded.
        await run(activities.grantTimeOff, { employeeId: HIRE.employeeId });
        assert.ok((timeOffGrant(HIRE.employeeId) ?? 0) > 0, "the new hire gets a positive PTO allotment");

        // Step 4 — system access provisioned.
        await run(activities.provisionAccess, { employeeId: HIRE.employeeId, email: HIRE.email });
        assert.equal(isProvisioned(HIRE.employeeId), true);

        // Step 5 — terminal activation flips status to "active".
        await run(activities.activateEmployee, { employeeId: HIRE.employeeId });
        const active = await directory.getEmployee(create(GetEmployeeRequestSchema, { id: HIRE.employeeId }));
        assert.equal(active.employee?.status, "active");
    });

    it("createEmployee on an already-taken id throws a NON-RETRYABLE EmployeeExists ApplicationFailure", async () => {
        // e-001 (Ada Lovelace) is in the seed → CreateEmployee is ALREADY_EXISTS,
        // which the activity rethrows as a non-retryable ApplicationFailure whose
        // `type` is exactly the value the workflow lists in nonRetryableErrorTypes.
        await assert.rejects(
            run(activities.createEmployee, { ...HIRE, employeeId: "e-001" }),
            (err: unknown) => err instanceof ApplicationFailure && err.type === "EmployeeExists" && err.nonRetryable === true && /already exists/i.test(err.message),
        );
    });

    it("createEmployee is idempotent: a retry observing its OWN prior commit succeeds (read-back equivalence)", async () => {
        // The first create commits the row; a Temporal retry re-runs the activity
        // and sees ALREADY_EXISTS. Read-back equivalence recognises the stored row
        // as THIS hire's own and returns success — not a duplicate-id failure.
        await run(activities.createEmployee, HIRE);
        await run(activities.createEmployee, HIRE);

        // Still exactly this hire, still in onboarding (the retry did not mutate it).
        const directory = server.localClient(DirectoryService);
        const employee = await directory.getEmployee(create(GetEmployeeRequestSchema, { id: HIRE.employeeId }));
        assert.equal(employee.employee?.status, "onboarding");
        assert.equal(employee.employee?.name, "New Hire");
    });

    // The read-back after ALREADY_EXISTS must compare every stored field: a row
    // that differs in any single one belongs to a different hire, so the retry
    // path must not mistake it for its own prior commit.
    const DIFFERENT_HIRE_FIELDS: Array<[keyof NewHire, string]> = [
        ["name", "Someone Else"],
        ["email", "someone.else@example.com"],
        ["title", "Janitor"],
        ["department", "Finance"],
        ["managerId", "e-003"],
    ];
    for (const [field, value] of DIFFERENT_HIRE_FIELDS) {
        it(`createEmployee on a taken id whose stored ${field} differs is a NON-RETRYABLE EmployeeExists`, async () => {
            await run(activities.createEmployee, HIRE);
            await assert.rejects(
                run(activities.createEmployee, { ...HIRE, [field]: value }),
                (err: unknown) => err instanceof ApplicationFailure && err.type === "EmployeeExists" && err.nonRetryable === true,
            );
        });
    }

    it("setupPayroll keeps the existing enrollment on a re-run instead of resetting a spent balance", async () => {
        const payroll = server.localClient(PayrollService);
        await run(activities.createEmployee, HIRE);
        await run(activities.setupPayroll, { employeeId: HIRE.employeeId });
        const enrolled = (await payroll.getBalance(create(GetBalanceRequestSchema, { employeeId: HIRE.employeeId }))).balance?.remainingDays ?? 0;

        // Spend leave through the real flow (TimeOff publishes, Payroll decrements).
        const timeoff = server.localClient(TimeOffService);
        await timeoff.requestLeave(create(RequestLeaveRequestSchema, { employeeId: HIRE.employeeId, days: 3 }));
        const spent = (await payroll.getBalance(create(GetBalanceRequestSchema, { employeeId: HIRE.employeeId }))).balance?.remainingDays;
        assert.equal(spent, enrolled - 3);

        // A Temporal retry re-runs the step: the balance must stay spent.
        await run(activities.setupPayroll, { employeeId: HIRE.employeeId });
        const afterRetry = (await payroll.getBalance(create(GetBalanceRequestSchema, { employeeId: HIRE.employeeId }))).balance?.remainingDays;
        assert.equal(afterRetry, enrolled - 3);
    });

    it("grantTimeOff keeps an existing grant on a re-run", async () => {
        const timeoff = server.localClient(TimeOffService);
        await timeoff.grantTimeOff(create(GrantTimeOffRequestSchema, { employeeId: HIRE.employeeId, policyDays: 7 }));
        await run(activities.grantTimeOff, { employeeId: HIRE.employeeId });
        assert.equal(timeOffGrant(HIRE.employeeId), 7);
    });

    it("provisionAccess twice provisions one account, not two", async () => {
        await run(activities.provisionAccess, { employeeId: HIRE.employeeId, email: HIRE.email });
        await run(activities.provisionAccess, { employeeId: HIRE.employeeId, email: HIRE.email });
        assert.equal(accessCount(), 1);
        assert.equal(isProvisioned(HIRE.employeeId), true);
    });

    it("compensations touch only their own employee", async () => {
        const payroll = server.localClient(PayrollService);
        const seededBalance = (await payroll.getBalance(create(GetBalanceRequestSchema, { employeeId: "e-001" }))).balance?.remainingDays;
        assert.ok((seededBalance ?? 0) > 0);

        await run(activities.setupPayroll, { employeeId: HIRE.employeeId });
        await run(activities.teardownPayroll, { employeeId: HIRE.employeeId });

        const hireBalance = (await payroll.getBalance(create(GetBalanceRequestSchema, { employeeId: HIRE.employeeId }))).balance?.remainingDays;
        assert.equal(hireBalance, 0, "the torn-down enrollment is gone");
        assert.equal((await payroll.getBalance(create(GetBalanceRequestSchema, { employeeId: "e-001" }))).balance?.remainingDays, seededBalance, "another employee's balance is untouched");
    });

    it("offboarding an unknown id creates no directory row", async () => {
        const directory = server.localClient(DirectoryService);
        await run(activities.offboardEmployee, { employeeId: "e-ghost" });
        await assert.rejects(
            directory.getEmployee(create(GetEmployeeRequestSchema, { id: "e-ghost" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.NotFound,
        );
    });

    it("offboardEmployee is idempotent: marking offboarded twice (and an unknown id) is a no-op success", async () => {
        const directory = server.localClient(DirectoryService);
        await run(activities.createEmployee, HIRE);

        await run(activities.offboardEmployee, { employeeId: HIRE.employeeId });
        const offboarded = await directory.getEmployee(create(GetEmployeeRequestSchema, { id: HIRE.employeeId }));
        assert.equal(offboarded.employee?.status, "offboarded");

        // Offboard again — already offboarded.
        await run(activities.offboardEmployee, { employeeId: HIRE.employeeId });
        // Offboard an id that never existed — still a no-op success.
        await run(activities.offboardEmployee, { employeeId: "e-ghost" });
    });

    it("teardownPayroll is idempotent: tearing down twice (and an unknown employee) is a no-op success", async () => {
        await run(activities.setupPayroll, { employeeId: HIRE.employeeId });
        await run(activities.teardownPayroll, { employeeId: HIRE.employeeId });
        // Tear down again — already removed.
        await run(activities.teardownPayroll, { employeeId: HIRE.employeeId });
        // Tear down an employee that was never enrolled — still a no-op success.
        await run(activities.teardownPayroll, { employeeId: "e-ghost" });
    });

    it("revokeTimeOff is idempotent: revoking twice (and an unknown employee) is a no-op success", async () => {
        await run(activities.grantTimeOff, { employeeId: HIRE.employeeId });
        assert.ok((timeOffGrant(HIRE.employeeId) ?? 0) > 0);

        await run(activities.revokeTimeOff, { employeeId: HIRE.employeeId });
        assert.equal(timeOffGrant(HIRE.employeeId), undefined);
        // Revoke again — already revoked.
        await run(activities.revokeTimeOff, { employeeId: HIRE.employeeId });
        // Revoke an unknown employee — still a no-op success.
        await run(activities.revokeTimeOff, { employeeId: "e-ghost" });
    });

    it("revokeAccess is idempotent: revoking twice (and an unknown employee) is a no-op success", async () => {
        await run(activities.provisionAccess, { employeeId: HIRE.employeeId, email: HIRE.email });
        assert.equal(accessCount(), 1);

        await run(activities.revokeAccess, { employeeId: HIRE.employeeId });
        assert.equal(isProvisioned(HIRE.employeeId), false);
        // Revoke again — already revoked.
        await run(activities.revokeAccess, { employeeId: HIRE.employeeId });
        // Revoke an unknown employee — still a no-op success.
        await run(activities.revokeAccess, { employeeId: "e-ghost" });
    });
});
