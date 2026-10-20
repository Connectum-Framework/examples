/**
 * Onboarding edge (OnboardingService) e2e — DOCKERLESS, no live Temporal.
 *
 * Exercises the gateway's SYNCHRONOUS pre-check and start contract without a
 * Temporal cluster, using an injected STUB `OnboardingWorkflowClient`:
 *
 *  - a FREE id passes the inverted pre-check (directory NotFound) and STARTS the
 *    saga: the response is STARTED, the workflow id equals the employee id, and
 *    the stub's `start` was invoked once;
 *  - an ALREADY-TAKEN id is rejected with `Code.AlreadyExists` BEFORE any
 *    Temporal use — the stub's `start` is never called;
 *  - GetOnboarding reads the live status via the stub's query;
 *  - with NO workflow client, a free id still passes the pre-check but then
 *    raises `Code.Unavailable` ("Temporal is not configured") — proving the
 *    pre-check runs first and the error path needs no live Temporal.
 *
 * The existing LeaveApproved flow (tests/e2e/e2e.test.ts) is untouched.
 *
 * @module tests/e2e/onboarding
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { Server } from "@connectum/core";
import { MemoryAdapter } from "@connectum/events";
import { QueryNotRegisteredError, QueryRejectedError, WorkflowNotFoundError } from "@temporalio/client";
import { TEMPORAL_TASK_QUEUE } from "#temporal/config.ts";
import { buildEventBus } from "#eventBus.ts";
import { GetOnboardingRequestSchema, OnboardEmployeeRequestSchema, OnboardingService } from "#gen/onboarding/v1/onboarding_pb.ts";
import { buildServer } from "#server.ts";
import type { OnboardingWorkflowClient } from "#services/onboardingService.ts";
import { resolveTopology } from "#topology.ts";
import { makeTestDb } from "../helpers/db.ts";

/** How a stub handle answers GetOnboarding: a live query result, or a closed describe(). */
interface StubHandleBehaviour {
    /** Status the live Query returns; if `undefined`, the Query throws. */
    readonly queryStatus?: string;
    /** Workflow status name returned by describe() when the Query is rejected. */
    readonly describeStatusName?: string;
    /**
     * When the Query throws (`queryStatus` undefined): `"closed"` (default) → a
     * `QueryNotRegisteredError` (run closed/gone) → describe() fallback;
     * `"transient"` → a generic error → surfaced as `Unavailable`.
     */
    readonly queryError?: "closed" | "transient" | "not-found" | "rejected";
}

/** What the handler asked the workflow client for while reading a status. */
interface ObservedReads {
    /** Every `start` call in order: workflow type plus the full options. */
    readonly starts: Array<{ type: string; options: { taskQueue: string; workflowId: string; args: unknown[] } }>;
    /** Workflow ids passed to `getHandle`, in call order. */
    readonly handleIds: string[];
    /** Query names passed to `handle.query`, in call order. */
    readonly queryNames: string[];
}

/** A stub workflow client recording started ids and answering from `handleBehaviour`. */
function makeStubClient(started: string[], handleBehaviour: () => StubHandleBehaviour, observed: ObservedReads): OnboardingWorkflowClient {
    return {
        async start(type, opts) {
            started.push(opts.workflowId);
            observed.starts.push({ type, options: { taskQueue: opts.taskQueue, workflowId: opts.workflowId, args: [...opts.args] } });
            return { workflowId: opts.workflowId };
        },
        getHandle(workflowId) {
            observed.handleIds.push(workflowId);
            const behaviour = handleBehaviour();
            return {
                async query<Ret>(queryName: string): Promise<Ret> {
                    observed.queryNames.push(queryName);
                    if (behaviour.queryStatus === undefined) {
                        if (behaviour.queryError === "transient") {
                            // A generic/infra failure — NOT a closed-run signal.
                            throw new Error("temporal frontend unavailable");
                        }
                        if (behaviour.queryError === "not-found") {
                            throw new WorkflowNotFoundError("workflow execution not found", workflowId, undefined);
                        }
                        if (behaviour.queryError === "rejected") {
                            // The query was refused because the run is closed.
                            throw new QueryRejectedError(2);
                        }
                        // Closed/gone run: its query handler is not registered.
                        // (code 3 = INVALID_ARGUMENT; the handler keys off the type.)
                        throw new QueryNotRegisteredError("query handler not registered on a closed run", 3);
                    }
                    return behaviour.queryStatus as Ret;
                },
                async describe() {
                    return { status: { name: behaviour.describeStatusName ?? "RUNNING" } };
                },
            };
        },
    };
}

describe("E2E: onboarding edge (pre-check + start, stub Temporal)", () => {
    let server: Server;
    const started: string[] = [];
    // Mutated per GetOnboarding test to drive the stub handle's query/describe.
    let handleBehaviour: StubHandleBehaviour = { queryStatus: "STARTED" };
    const observed: ObservedReads = { starts: [], handleIds: [], queryNames: [] };

    before(async () => {
        const topology = resolveTopology("*");
        const eventBus = buildEventBus({ localTypeNames: topology.localTypeNames, adapter: MemoryAdapter() });
        const db = await makeTestDb();
        server = buildServer({ port: 0, topology, eventBus, db, workflowClient: makeStubClient(started, () => handleBehaviour, observed) });
        await server.start();
    });

    after(async () => {
        if (server.state === "running") await server.stop();
    });

    it("OnboardEmployee on a FREE id passes the pre-check and STARTS the saga", async () => {
        const onboarding = server.localClient(OnboardingService);
        const before = started.length;

        const res = await onboarding.onboardEmployee(
            create(OnboardEmployeeRequestSchema, {
                employeeId: "e-300",
                name: "New Hire",
                email: "newhire@example.com",
                title: "Software Engineer",
                department: "Engineering",
                managerId: "e-002",
            }),
        );

        assert.equal(res.onboarding?.status, "STARTED");
        assert.equal(res.workflowId, "e-300");
        assert.equal(started.length, before + 1);
        assert.equal(started.at(-1), "e-300");

        // What the saga actually receives: the workflow the proto names, on the
        // queue the worker polls, with the hire's data exactly as requested.
        assert.deepEqual(observed.starts.at(-1), {
            type: "OnboardingWorkflow",
            options: {
                taskQueue: TEMPORAL_TASK_QUEUE,
                workflowId: "e-300",
                args: [
                    {
                        employeeId: "e-300",
                        name: "New Hire",
                        email: "newhire@example.com",
                        title: "Software Engineer",
                        department: "Engineering",
                        managerId: "e-002",
                    },
                ],
            },
        });
    });

    it("OnboardEmployee on an ALREADY-TAKEN id is rejected with AlreadyExists, never touching Temporal", async () => {
        const onboarding = server.localClient(OnboardingService);
        const before = started.length;

        await assert.rejects(
            // e-001 (Ada Lovelace) is in the seed.
            onboarding.onboardEmployee(create(OnboardEmployeeRequestSchema, { employeeId: "e-001", name: "Dup", email: "dup@example.com", title: "x", department: "y", managerId: "" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.AlreadyExists,
        );

        // The pre-check rejected before the workflow start — stub untouched.
        assert.equal(started.length, before);
    });

    it("GetOnboarding returns the status the workflow query reports, for the requested employee's workflow", async () => {
        // The proto documents GetOnboarding as reading the new hire's live status
        // from the running workflow through a Temporal query (the workflow id is
        // the employee id), and falling back to a terminal status only once the
        // saga has closed. So the answer must come from the query, not from
        // describe(): describe() is rigged to report the OPPOSITE outcome, which
        // makes a handler that reads describe() (or hard-codes a status) fail.
        // Two different query answers and two different employee ids prove the
        // status and the id are not constants.
        const onboarding = server.localClient(OnboardingService);
        observed.handleIds.length = 0;
        observed.queryNames.length = 0;

        handleBehaviour = { queryStatus: "STARTED", describeStatusName: "COMPLETED" };
        const running = await onboarding.getOnboarding(create(GetOnboardingRequestSchema, { employeeId: "e-300" }));
        assert.equal(running.onboarding?.status, "STARTED");
        assert.equal(running.onboarding?.employeeId, "e-300");

        handleBehaviour = { queryStatus: "COMPLETED", describeStatusName: "FAILED" };
        const done = await onboarding.getOnboarding(create(GetOnboardingRequestSchema, { employeeId: "e-301" }));
        assert.equal(done.onboarding?.status, "COMPLETED");
        assert.equal(done.onboarding?.employeeId, "e-301");

        assert.deepEqual(observed.handleIds, ["e-300", "e-301"]);
        assert.deepEqual(observed.queryNames, ["getOnboardingStatus", "getOnboardingStatus"]);
    });

    it("GetOnboarding falls back to a terminal status via describe() when the workflow has CLOSED", async () => {
        // queryStatus undefined → the stub Query throws a QueryNotRegisteredError
        // (run closed/gone), which the handler treats as "fall back to describe()".
        const onboarding = server.localClient(OnboardingService);
        handleBehaviour = { describeStatusName: "COMPLETED" };
        const done = await onboarding.getOnboarding(create(GetOnboardingRequestSchema, { employeeId: "e-300" }));
        assert.equal(done.onboarding?.status, "COMPLETED");

        handleBehaviour = { describeStatusName: "FAILED" };
        const failed = await onboarding.getOnboarding(create(GetOnboardingRequestSchema, { employeeId: "e-300" }));
        assert.equal(failed.onboarding?.status, "FAILED");
    });

    // The proto allows only COMPLETED on success and FAILED if the saga rolled
    // back: a closed run that did not complete (terminated, timed out, cancelled)
    // never completed the onboarding, so it must not be reported as COMPLETED.
    for (const closedWithoutSuccess of ["FAILED", "TERMINATED", "TIMED_OUT", "CANCELLED"]) {
        it(`GetOnboarding reports FAILED for a closed run that ended ${closedWithoutSuccess}`, async () => {
            const onboarding = server.localClient(OnboardingService);
            handleBehaviour = { describeStatusName: closedWithoutSuccess };
            const res = await onboarding.getOnboarding(create(GetOnboardingRequestSchema, { employeeId: "e-300" }));
            assert.equal(res.onboarding?.status, "FAILED");
        });
    }

    // Both signals mean "the run is closed or gone", the same situation as an
    // unregistered query handler, so the terminal status still comes from describe().
    for (const queryError of ["not-found", "rejected"] as const) {
        it(`GetOnboarding falls back to describe() when the live query fails with a ${queryError} signal`, async () => {
            const onboarding = server.localClient(OnboardingService);
            handleBehaviour = { queryError, describeStatusName: "COMPLETED" };
            const res = await onboarding.getOnboarding(create(GetOnboardingRequestSchema, { employeeId: "e-300" }));
            assert.equal(res.onboarding?.status, "COMPLETED");
        });
    }

    it("GetOnboarding surfaces Unavailable (NOT a terminal status) when the live Query fails transiently", async () => {
        // Regression for the blanket catch that mapped ANY query error to a
        // terminal status: a transient/infra failure must surface as Unavailable,
        // never be silently reported as a COMPLETED/FAILED onboarding.
        const onboarding = server.localClient(OnboardingService);
        handleBehaviour = { queryError: "transient" };
        await assert.rejects(
            onboarding.getOnboarding(create(GetOnboardingRequestSchema, { employeeId: "e-300" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.Unavailable,
        );
    });
});

describe("E2E: onboarding edge with NO Temporal client (pre-check still runs)", () => {
    let server: Server;

    before(async () => {
        const topology = resolveTopology("*");
        const eventBus = buildEventBus({ localTypeNames: topology.localTypeNames, adapter: MemoryAdapter() });
        const db = await makeTestDb();
        // workflowClient: null → force the "Temporal not configured" path.
        server = buildServer({ port: 0, topology, eventBus, db, workflowClient: null });
        await server.start();
    });

    after(async () => {
        if (server.state === "running") await server.stop();
    });

    it("a FREE id passes the pre-check but then raises Unavailable (no Temporal)", async () => {
        const onboarding = server.localClient(OnboardingService);
        await assert.rejects(
            onboarding.onboardEmployee(create(OnboardEmployeeRequestSchema, { employeeId: "e-301", name: "x", email: "x@example.com", title: "x", department: "y", managerId: "" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.Unavailable,
        );
    });

    it("an ALREADY-TAKEN id is still rejected with AlreadyExists (pre-check independent of Temporal)", async () => {
        const onboarding = server.localClient(OnboardingService);
        await assert.rejects(
            onboarding.onboardEmployee(create(OnboardEmployeeRequestSchema, { employeeId: "e-002", name: "x", email: "x@example.com", title: "x", department: "y", managerId: "" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.AlreadyExists,
        );
    });
});
