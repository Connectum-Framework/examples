/**
 * TripWorkflow orchestration + compensation tests — DOCKERLESS.
 *
 * Uses Temporal's time-skipping test environment (an EMBEDDED test server — no
 * Docker; the server binary is downloaded + cached on first run only) with a
 * worker whose ACTIVITIES ARE MOCKED (plain JS functions that record their call
 * order). The WORKFLOW is the real `TripWorkflow`, so this asserts the saga's
 * orchestration without any Connectum server or Temporal cluster:
 *
 *  - success: forward order is reserveVehicle → recordTrip → endTrip → openTab
 *    → addCharge → settle.
 *  - settle fails: the recorded tail unwinds in LIFO order —
 *    refundCharge → voidTab → markTripCancelled → releaseVehicle.
 *  - endTrip fails: only the 2→1 compensations run —
 *    markTripCancelled → releaseVehicle (no billing comps, since steps 5–7
 *    never ran).
 *  - reserve fails (non-retryable): fails fast with NO compensation.
 *
 * Time-skipping resolves the workflow's "drive" timer instantly. Failures are
 * forced by making the MOCK throw `ApplicationFailure.nonRetryable`, so the
 * production retry policy stays realistic (this test does not depend on
 * `maximumAttempts`).
 *
 * @module tests/workflow/tripWorkflow
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ApplicationFailure } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import * as realActivities from "#temporal/activities.ts";
import type { TripWorkflowInput } from "#temporal/workflows.ts";
import { TripWorkflow } from "#temporal/workflows.ts";

/** The workflow bundle source — the same `.ts` the production worker bundles. */
const WORKFLOWS_PATH = fileURLToPath(new URL("../../src/temporal/workflows.ts", import.meta.url));

const TASK_QUEUE = "test-trip-saga";
const INPUT: TripWorkflowInput = { userId: "user-42", vehicleId: "v-001", tripId: "trip-test-1" };

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
        reserveVehicle: async () => record("reserveVehicle"),
        releaseVehicle: async () => record("releaseVehicle"),
        recordTrip: async () => record("recordTrip"),
        markTripCancelled: async () => record("markTripCancelled"),
        endTrip: async () => record("endTrip"),
        openTab: async () => record("openTab"),
        voidTab: async () => record("voidTab"),
        addCharge: async () => record("addCharge", "charge-mock-1"),
        refundCharge: async () => record("refundCharge"),
        settle: async () => record("settle"),
        // Phase 3 terminal broadcast — fired from the success-only tail AFTER the
        // saga try/catch, so it appears only on the SETTLED path.
        publishTripCompleted: async () => record("publishTripCompleted"),
    };
}

describe("TripWorkflow: orchestration + compensation (time-skipping, mocked activities)", () => {
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
        return worker.runUntil(testEnv.client.workflow.execute(TripWorkflow, { args: [INPUT], taskQueue: TASK_QUEUE, workflowId }));
    }

    it("success: runs the forward steps in order, SETTLES, then broadcasts TripCompleted (success-only tail)", async () => {
        const calls: string[] = [];
        const result = await runWorkflow(makeMockActivities(calls), "wf-success");

        assert.equal(result, "SETTLED");
        // The terminal broadcast fires LAST, after settle — the success-only tail
        // outside the saga try/catch (Phase 3).
        assert.deepEqual(calls, ["reserveVehicle", "recordTrip", "endTrip", "openTab", "addCharge", "settle", "publishTripCompleted"]);
    });

    it("settle fails: compensations run in REVERSE order (refund → void → cancel → release)", async () => {
        const calls: string[] = [];
        await assert.rejects(runWorkflow(makeMockActivities(calls, { step: "settle" }), "wf-settle-fail"));

        // Forward path up to and including the failing settle, then the LIFO
        // unwind of every pushed compensation. The ABSENCE of `publishTripCompleted`
        // here is the negative guard: the broadcast fires only on the SETTLED tail,
        // NEVER on a compensated (CANCELLED) run.
        assert.deepEqual(calls, [
            "reserveVehicle",
            "recordTrip",
            "endTrip",
            "openTab",
            "addCharge",
            "settle", // throws
            "refundCharge",
            "voidTab",
            "markTripCancelled",
            "releaseVehicle",
        ]);
    });

    it("endTrip fails: only the 2→1 compensations run (cancel trip → release vehicle)", async () => {
        const calls: string[] = [];
        await assert.rejects(runWorkflow(makeMockActivities(calls, { step: "endTrip" }), "wf-endtrip-fail"));

        // No billing steps ran, so no billing compensations — just the trip
        // record and the vehicle reservation unwind, in reverse.
        assert.deepEqual(calls, ["reserveVehicle", "recordTrip", "endTrip", "markTripCancelled", "releaseVehicle"]);
    });

    it("reserve fails (non-retryable): fails fast with NO compensation", async () => {
        const calls: string[] = [];
        await assert.rejects(runWorkflow(makeMockActivities(calls, { step: "reserveVehicle" }), "wf-reserve-fail"));

        // Nothing was pushed before the failing first step, so nothing unwinds.
        assert.deepEqual(calls, ["reserveVehicle"]);
    });

    it("recordTrip fails: its PRE-registered cancel still unwinds (markTripCancelled → releaseVehicle)", async () => {
        // F4 (register-before): markTripCancelled is on the stack BEFORE recordTrip
        // is awaited, so an ambiguous recordTrip failure still unwinds it (it
        // no-ops if the record never committed). With the old register-AFTER order
        // this compensation would have been missed entirely.
        const calls: string[] = [];
        await assert.rejects(runWorkflow(makeMockActivities(calls, { step: "recordTrip" }), "wf-record-fail"));
        assert.deepEqual(calls, ["reserveVehicle", "recordTrip", "markTripCancelled", "releaseVehicle"]);
    });

    it("openTab fails: its PRE-registered void still unwinds (void → cancel → release)", async () => {
        // F4 (register-before): voidTab is registered BEFORE openTab, so an
        // ambiguous openTab failure still unwinds it (no-op on a missing tab).
        const calls: string[] = [];
        await assert.rejects(runWorkflow(makeMockActivities(calls, { step: "openTab" }), "wf-opentab-fail"));
        assert.deepEqual(calls, ["reserveVehicle", "recordTrip", "endTrip", "openTab", "voidTab", "markTripCancelled", "releaseVehicle"]);
    });

    it("broadcast failure leaves the trip SETTLED — the success-only tail swallows it, NO compensation runs", async () => {
        // The CRITICAL Phase 3 guarantee (D4): a failed/timed-out broadcast must
        // NEVER roll back a settled, paid trip. The mock's `publishTripCompleted`
        // throws (nonRetryable), but it runs in the success-only tail OUTSIDE the
        // saga try/catch, so the catch does not see it: the workflow still returns
        // SETTLED and NO compensation follows. This proves the guard behaviorally
        // (the structural placement), not by code-reading.
        const calls: string[] = [];
        const result = await runWorkflow(makeMockActivities(calls, { step: "publishTripCompleted" }), "wf-broadcast-fail");

        assert.equal(result, "SETTLED");
        assert.deepEqual(calls, ["reserveVehicle", "recordTrip", "endTrip", "openTab", "addCharge", "settle", "publishTripCompleted"]);
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
            taskQueue: "test-real-activities",
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
