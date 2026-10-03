/**
 * Records `tests/fixtures/onboarding-before-announce/history.json` — the event
 * history of an onboarding that completed under the workflow code that existed
 * BEFORE the `EmployeeOnboarded` announcement step was added.
 *
 * Why the fixture exists: Temporal keeps the history of every closed run, and
 * GetOnboarding answers a status query on a closed run by replaying that
 * history through the CURRENT workflow code. Runs that finished before the
 * announcement step existed have no trace of it, so the current code must skip
 * the step for them (the `patched(...)` guard). `tests/workflow/replay.test.ts`
 * replays this file to prove it does; without a real old history that guard
 * would be untested, because every new run takes the patched branch.
 *
 * What it runs: the frozen copy of the pre-change workflow in
 * `tests/fixtures/onboarding-before-announce/workflows.ts` (examples commit
 * 85968c1, `hris/src/temporal/workflows.ts`), in Temporal's time-skipping test
 * server, with activities replaced by no-op mocks — the replay never executes
 * activities, it only needs their completion events in the history.
 *
 * When to run it: ONLY when deliberately re-baselining the fixture, for example
 * after a Temporal SDK upgrade changes the history format. Never to make a
 * failing replay test pass: a failing replay means the current workflow can no
 * longer read histories that production already holds.
 *
 *     pnpm run fixtures:onboarding-history
 *
 * Reproducibility: every run records the same sequence of events with the same
 * attributes. What differs between runs is the event timestamps and run ids,
 * which the server assigns, and the order inside `sdkMetadata.coreUsedFlags`,
 * which the SDK core reports as an unordered set; the replay depends on none of
 * them. Worker and client
 * identities are pinned, because their default is `<pid>@<hostname>` and would
 * leak the machine name into the repository.
 *
 * Format: the standard Temporal history JSON, the same shape the Temporal CLI
 * and Web UI export. It is written by the SDK's `historyToJSON`, the exact
 * inverse of the `historyFromJSON` that `Worker.runReplayHistory` applies when
 * it is handed parsed JSON. A plain `JSON.stringify(fetchHistory())` is NOT
 * that format — it writes timestamps as `{ seconds, nanos }` objects, which the
 * loader rejects ("expected timestamp string"). Before writing, the script reads
 * the serialized text back and replays it against the same frozen workflow, so
 * a history the SDK cannot load is never saved.
 *
 * @module scripts/record-onboarding-history
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
// `historyToJSON` writes the same JSON history format the replay worker reads
// back (`historyFromJSON`); plain `JSON.stringify` of the history object writes
// timestamps as objects, which the loader rejects. The package root does not
// re-export it, hence the `lib/` path.
import { historyToJSON } from "@temporalio/common/lib/proto-utils.js";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";


const FIXTURE_DIR = new URL("../tests/fixtures/onboarding-before-announce/", import.meta.url);
const WORKFLOWS_PATH = fileURLToPath(new URL("workflows.ts", FIXTURE_DIR));
const HISTORY_PATH = fileURLToPath(new URL("history.json", FIXTURE_DIR));

const IDENTITY = "record-onboarding-history";
const TASK_QUEUE = "record-onboarding-history";
const WORKFLOW_ID = "onboarding-before-announce";

/** The same new hire the workflow tests use, so the fixture reads like them. */
const INPUT = {
    employeeId: "e-100",
    name: "New Hire",
    email: "newhire@example.com",
    title: "Software Engineer",
    department: "Engineering",
    managerId: "e-002",
};

/** Every activity the pre-change workflow can call; each succeeds with no result. */
const noop = async (): Promise<void> => {};
const activities = {
    createEmployee: noop,
    offboardEmployee: noop,
    setupPayroll: noop,
    teardownPayroll: noop,
    grantTimeOff: noop,
    revokeTimeOff: noop,
    provisionAccess: noop,
    revokeAccess: noop,
    activateEmployee: noop,
};

const testEnv = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: IDENTITY } });
try {
    const worker = await Worker.create({
        connection: testEnv.nativeConnection,
        identity: IDENTITY,
        taskQueue: TASK_QUEUE,
        workflowsPath: WORKFLOWS_PATH,
        activities,
    });
    // Started by type name: the frozen module is never imported here, only
    // bundled by the worker, exactly as production starts it.
    const result = await worker.runUntil(
        testEnv.client.workflow.execute("OnboardingWorkflow", { args: [INPUT], taskQueue: TASK_QUEUE, workflowId: WORKFLOW_ID }),
    );
    if (result !== "COMPLETED") {
        throw new Error(`the pre-change workflow finished with ${JSON.stringify(result)}, expected "COMPLETED"`);
    }

    const history = await testEnv.client.workflow.getHandle(WORKFLOW_ID).fetchHistory();
    const text = `${historyToJSON(history)}\n`;

    await Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, JSON.parse(text));

    await writeFile(HISTORY_PATH, text);
    console.log(`wrote ${HISTORY_PATH} (${history.events?.length ?? 0} events)`);
} finally {
    await testEnv.teardown();
}
