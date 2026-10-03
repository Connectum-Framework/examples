/**
 * OnboardingWorkflow replay compatibility with runs that finished BEFORE the
 * `EmployeeOnboarded` announcement step existed — DOCKERLESS, no Temporal
 * server at all (a replay only feeds a recorded history to the workflow code).
 *
 * Why it matters: Temporal keeps every closed run's history, and GetOnboarding
 * answers a status query on a closed run by replaying that history through the
 * CURRENT workflow code. A history recorded by the old code jumps straight from
 * `activateEmployee` to "workflow completed". If the current code tried to
 * schedule `announceOnboarded` there, the replay would fail with a
 * nondeterminism error and GetOnboarding would break for every onboarding that
 * completed before the upgrade. The `patched(...)` guard around the step is
 * what prevents that; this test is the only place it is exercised with
 * `patched` returning false, since every new run takes the patched branch.
 *
 * The fixture was recorded from the old workflow code by
 * `scripts/record-onboarding-history.ts`; see that file for how and when to
 * regenerate it.
 *
 * @module tests/workflow/replay
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";

/** The workflow bundle source — the same `.ts` the production worker bundles. */
const WORKFLOWS_PATH = fileURLToPath(new URL("../../src/temporal/workflows.ts", import.meta.url));
const HISTORY_PATH = new URL("../fixtures/onboarding-before-announce/history.json", import.meta.url);

/** The parts of the Temporal history JSON format this test inspects. */
interface HistoryJson {
    readonly events: ReadonlyArray<{
        readonly eventType: string;
        readonly activityTaskScheduledEventAttributes?: { readonly activityType: { readonly name: string } };
    }>;
}

describe("OnboardingWorkflow: replay of a history recorded before the announcement step", () => {
    it("the fixture really is a completed pre-change run: no patch marker, no announceOnboarded", async () => {
        // Guards the fixture itself. Were it re-recorded from the current code,
        // the replay below would pass through the patched branch and prove
        // nothing about old runs.
        const history = JSON.parse(await readFile(HISTORY_PATH, "utf8")) as HistoryJson;
        const scheduled = history.events.flatMap((event) => (event.activityTaskScheduledEventAttributes ? [event.activityTaskScheduledEventAttributes.activityType.name] : []));

        assert.deepEqual(scheduled, ["createEmployee", "setupPayroll", "grantTimeOff", "provisionAccess", "activateEmployee"]);
        assert.equal(
            history.events.some((event) => event.eventType === "EVENT_TYPE_MARKER_RECORDED"),
            false,
        );
        assert.equal(history.events.at(-1)?.eventType, "EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED");
    });

    it("replays against the current workflow without a nondeterminism error", async () => {
        const history: unknown = JSON.parse(await readFile(HISTORY_PATH, "utf8"));

        // Rejects with DeterminismViolationError if the current code issues a
        // command the old history does not contain — which is exactly what an
        // unguarded announceOnboarded would do.
        await assert.doesNotReject(Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history));
    });
});
