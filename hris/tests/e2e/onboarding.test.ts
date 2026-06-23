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
import { QueryNotRegisteredError } from "@temporalio/client";
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
    readonly queryError?: "closed" | "transient";
}

/** A stub workflow client recording started ids and answering from `handleBehaviour`. */
function makeStubClient(started: string[], handleBehaviour: () => StubHandleBehaviour): OnboardingWorkflowClient {
    return {
        async start(_type, opts) {
            started.push(opts.workflowId);
            return { workflowId: opts.workflowId };
        },
        getHandle() {
            const behaviour = handleBehaviour();
            return {
                async query<Ret>(): Promise<Ret> {
                    if (behaviour.queryStatus === undefined) {
                        if (behaviour.queryError === "transient") {
                            // A generic/infra failure — NOT a closed-run signal.
                            throw new Error("temporal frontend unavailable");
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

    before(async () => {
        const topology = resolveTopology("*");
        const eventBus = buildEventBus({ localTypeNames: topology.localTypeNames, adapter: MemoryAdapter() });
        const db = await makeTestDb();
        server = buildServer({ port: 0, topology, eventBus, db, workflowClient: makeStubClient(started, () => handleBehaviour) });
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

    it("GetOnboarding reads the live status via the workflow query", async () => {
        handleBehaviour = { queryStatus: "STARTED" };
        const onboarding = server.localClient(OnboardingService);
        const res = await onboarding.getOnboarding(create(GetOnboardingRequestSchema, { employeeId: "e-300" }));
        assert.equal(res.onboarding?.status, "STARTED");
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
