/**
 * OnboardingWorkflow orchestration + compensation tests — DOCKERLESS.
 *
 * Uses Temporal's time-skipping test environment (an EMBEDDED test server — no
 * Docker; the server binary is downloaded + cached on first run only) with a
 * worker whose ACTIVITIES ARE MOCKED (plain JS functions that record their call
 * order). The WORKFLOW is the real `OnboardingWorkflow`, so this asserts the
 * saga's orchestration without any Connectum server or Temporal cluster:
 *
 *  - success: forward order is createEmployee → setupPayroll → grantTimeOff →
 *    provisionAccess → activateEmployee.
 *  - activateEmployee fails: the recorded tail unwinds in LIFO order —
 *    revokeAccess → revokeTimeOff → teardownPayroll → offboardEmployee.
 *  - provisionAccess fails: only the 3→1 compensations run (provisionAccess
 *    pushed nothing before failing) — revokeTimeOff → teardownPayroll →
 *    offboardEmployee.
 *  - setupPayroll fails: only offboardEmployee runs.
 *  - createEmployee fails (non-retryable): fails fast with NO compensation.
 *
 * Failures are forced by making the MOCK throw `ApplicationFailure.nonRetryable`,
 * so the production retry policy stays realistic (this test does not depend on
 * `maximumAttempts`).
 *
 * @module tests/workflow/onboardingWorkflow
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ApplicationFailure } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import * as realActivities from "#temporal/activities.ts";
import type { OnboardingWorkflowInput } from "#temporal/workflows.ts";
import { OnboardingWorkflow } from "#temporal/workflows.ts";

/** The workflow bundle source — the same `.ts` the production worker bundles. */
const WORKFLOWS_PATH = fileURLToPath(new URL("../../src/temporal/workflows.ts", import.meta.url));

const TASK_QUEUE = "test-onboarding-saga";
const INPUT: OnboardingWorkflowInput = {
    employeeId: "e-100",
    name: "New Hire",
    email: "newhire@example.com",
    title: "Software Engineer",
    department: "Engineering",
    managerId: "e-002",
};

/** Build a mock activity set that records call order into `calls`. */
function makeMockActivities(calls: string[], failing?: { step: string }): Record<string, (...args: unknown[]) => Promise<unknown>> {
    const record = (name: string, result: unknown = undefined) => {
        calls.push(name);
        if (failing?.step === name) {
            // Non-retryable so the run fails immediately without depending on
            // the production retry budget.
            throw ApplicationFailure.create({ message: `mock ${name} failed`, type: "MockFailure", nonRetryable: true });
        }
        return result;
    };
    return {
        createEmployee: async () => record("createEmployee"),
        offboardEmployee: async () => record("offboardEmployee"),
        setupPayroll: async () => record("setupPayroll"),
        teardownPayroll: async () => record("teardownPayroll"),
        grantTimeOff: async () => record("grantTimeOff"),
        revokeTimeOff: async () => record("revokeTimeOff"),
        provisionAccess: async () => record("provisionAccess"),
        revokeAccess: async () => record("revokeAccess"),
        activateEmployee: async () => record("activateEmployee"),
        announceOnboarded: async () => record("announceOnboarded"),
    };
}

describe("OnboardingWorkflow: orchestration + compensation (time-skipping, mocked activities)", () => {
    let testEnv: TestWorkflowEnvironment;

    before(async () => {
        testEnv = await TestWorkflowEnvironment.createTimeSkipping();
    });

    after(async () => {
        await testEnv?.teardown();
    });

    /** Run the workflow once with a worker whose activities are `activities`. */
    async function runWorkflow(activities: Record<string, (...args: unknown[]) => Promise<unknown>>, workflowId: string): Promise<unknown> {
        const worker = await Worker.create({
            connection: testEnv.nativeConnection,
            taskQueue: TASK_QUEUE,
            workflowsPath: WORKFLOWS_PATH,
            activities,
        });
        return worker.runUntil(testEnv.client.workflow.execute(OnboardingWorkflow, { args: [INPUT], taskQueue: TASK_QUEUE, workflowId }));
    }

    it("success: runs the forward steps in order, COMPLETES, and broadcasts EmployeeOnboarded last", async () => {
        const calls: string[] = [];
        const result = await runWorkflow(makeMockActivities(calls), "wf-success");

        assert.equal(result, "COMPLETED");
        assert.deepEqual(calls, ["createEmployee", "setupPayroll", "grantTimeOff", "provisionAccess", "activateEmployee", "announceOnboarded"]);
    });

    it("a failed broadcast does NOT roll back or fail a completed onboarding (fire-and-forget)", async () => {
        const calls: string[] = [];
        // announceOnboarded throws, but it runs OUTSIDE the saga's compensation
        // scope and the workflow swallows it — the run still resolves COMPLETED,
        // no compensation fires, and the employee stays active.
        const result = await runWorkflow(makeMockActivities(calls, { step: "announceOnboarded" }), "wf-broadcast-fail");

        assert.equal(result, "COMPLETED");
        assert.deepEqual(calls, ["createEmployee", "setupPayroll", "grantTimeOff", "provisionAccess", "activateEmployee", "announceOnboarded"]);
    });

    it("activateEmployee fails: compensations run in REVERSE order (revokeAccess → revokeTimeOff → teardownPayroll → offboardEmployee)", async () => {
        const calls: string[] = [];
        await assert.rejects(runWorkflow(makeMockActivities(calls, { step: "activateEmployee" }), "wf-activate-fail"));

        // Forward path up to and including the failing activate, then the LIFO
        // unwind of every pushed compensation.
        assert.deepEqual(calls, [
            "createEmployee",
            "setupPayroll",
            "grantTimeOff",
            "provisionAccess",
            "activateEmployee", // throws
            "revokeAccess",
            "revokeTimeOff",
            "teardownPayroll",
            "offboardEmployee",
        ]);
    });

    it("provisionAccess fails: the 3→1 compensations run (revokeTimeOff → teardownPayroll → offboardEmployee)", async () => {
        const calls: string[] = [];
        await assert.rejects(runWorkflow(makeMockActivities(calls, { step: "provisionAccess" }), "wf-provision-fail"));

        // provisionAccess pushed NO compensation before failing, so the unwind
        // starts from step 3's revokeTimeOff.
        assert.deepEqual(calls, ["createEmployee", "setupPayroll", "grantTimeOff", "provisionAccess", "revokeTimeOff", "teardownPayroll", "offboardEmployee"]);
    });

    it("setupPayroll fails: only offboardEmployee compensates (step 1's undo)", async () => {
        const calls: string[] = [];
        await assert.rejects(runWorkflow(makeMockActivities(calls, { step: "setupPayroll" }), "wf-setup-fail"));

        // Only createEmployee pushed a compensation before setupPayroll failed.
        assert.deepEqual(calls, ["createEmployee", "setupPayroll", "offboardEmployee"]);
    });

    it("createEmployee fails (non-retryable): fails fast with NO compensation", async () => {
        const calls: string[] = [];
        await assert.rejects(runWorkflow(makeMockActivities(calls, { step: "createEmployee" }), "wf-create-fail"));

        // Nothing was pushed before the failing first step, so nothing unwinds.
        assert.deepEqual(calls, ["createEmployee"]);
    });

    it("the REAL activities module + real workflowsPath register on a Worker (production startup path)", async () => {
        // The other tests pass hand-built mock activities; this is the ONLY test
        // that exercises the exact registration `src/worker.ts` does — the real
        // activities namespace (its lazy ConnectRPC clients are not built by
        // Worker.create, which only registers, never invokes) plus the real
        // workflow bundle. Catches a non-function export or a bundle break that
        // would otherwise only surface at `node src/worker.ts` startup.
        const worker = await Worker.create({
            connection: testEnv.nativeConnection,
            taskQueue: "test-real-onboarding-activities",
            workflowsPath: WORKFLOWS_PATH,
            activities: realActivities,
        });
        assert.ok(worker);
        // Start and immediately stop so the worker's poll/heartbeat loop is
        // drained and shut down — a created-but-never-run worker leaks a
        // background loop and the test process never exits.
        await worker.runUntil(Promise.resolve());
    });
});
