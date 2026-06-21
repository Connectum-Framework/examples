/**
 * OnboardingWorkflow — the durable new-hire onboarding saga (Temporal workflow
 * code).
 *
 * This file is the worker's `workflowsPath` target: it is bundled (webpack +
 * swc) and runs in Temporal's DETERMINISTIC sandbox. It therefore imports ONLY
 * `@temporalio/workflow`, the activity *types*, and the side-effect-free
 * `onboardingStatus.ts` — never Node built-ins, Connectum, or the generated
 * runtime (that would break determinism). All I/O is in the activities; the
 * workflow only orchestrates.
 *
 * Saga (compensation-stack pattern, samples-repo style): run the forward steps
 * in order; after each side-effecting step `unshift` its compensation onto a
 * stack; on ANY failure, run the compensations in LIFO order (each wrapped in
 * its own try/catch so the unwind never throws), then rethrow the original
 * error. The result:
 *   - provisionAccess fails → teardownPayroll → ... wait, LIFO from the failing
 *     point: revokeTimeOff → teardownPayroll → offboardEmployee
 *   - grantTimeOff fails    → teardownPayroll → offboardEmployee
 *   - setupPayroll fails    → offboardEmployee
 *   - createEmployee fails  → (non-retryable) fail fast, NOTHING to compensate.
 *
 * activateEmployee (step 5) pushes NO compensation: it is the terminal
 * happy-path step, so a success is final and there is nothing after it to roll
 * back.
 *
 * Live status is exposed via `getOnboardingStatusQuery` so the gateway's
 * GetOnboarding can read it with `handle.query(getOnboardingStatusQuery)`.
 *
 * @module temporal/workflows
 */

import { ApplicationFailure, defineQuery, log, proxyActivities, setHandler } from "@temporalio/workflow";
import type * as activities from "#temporal/activities.ts";
import type { OnboardingStatus as OnboardingStatusT } from "#temporal/onboardingStatus.ts";
import { OnboardingStatus } from "#temporal/onboardingStatus.ts";

/** Input to {@link OnboardingWorkflow}. */
export interface OnboardingWorkflowInput {
    readonly employeeId: string;
    readonly name: string;
    readonly email: string;
    readonly title: string;
    readonly department: string;
    readonly managerId: string;
}

/**
 * Query for the onboarding's live status, read from outside via
 * `handle.query(getOnboardingStatusQuery)`. Returns the current
 * {@link OnboardingStatus}.
 */
export const getOnboardingStatusQuery = defineQuery<OnboardingStatusT>("getOnboardingStatus");

/** A single compensation: a label (for assertions/logs) and its undo action. */
interface Compensation {
    readonly name: string;
    readonly run: () => Promise<void>;
}

/**
 * Activity proxies. `createEmployee`'s business failure is non-retryable (the
 * activity rethrows `ApplicationFailure(EmployeeExists)`); every other step
 * keeps Temporal's default retry policy, which is the durability the saga
 * demonstrates.
 */
const acts = proxyActivities<typeof activities>({
    startToCloseTimeout: "30 seconds",
    retry: {
        initialInterval: "1 second",
        maximumAttempts: 5,
        // A duplicate-id business failure must not be retried.
        nonRetryableErrorTypes: ["EmployeeExists"],
    },
});

/**
 * Run the onboarding saga for a new hire.
 *
 * @param input - {@link OnboardingWorkflowInput}.
 * @returns the terminal onboarding status (`COMPLETED` on success).
 */
export async function OnboardingWorkflow(input: OnboardingWorkflowInput): Promise<OnboardingStatusT> {
    const { employeeId, name, email, title, department, managerId } = input;

    let status: OnboardingStatusT = OnboardingStatus.STARTED;
    setHandler(getOnboardingStatusQuery, () => status);

    // LIFO compensation stack: unshift after each side-effecting forward step.
    const compensations: Compensation[] = [];

    try {
        // Step 1 — create the directory row (business failure here is
        // non-retryable and fails the workflow fast; nothing pushed, nothing to
        // undo).
        await acts.createEmployee({ employeeId, name, email, title, department, managerId });
        compensations.unshift({ name: "offboardEmployee", run: () => acts.offboardEmployee({ employeeId }) });

        // Step 2 — enroll in payroll.
        await acts.setupPayroll({ employeeId });
        compensations.unshift({ name: "teardownPayroll", run: () => acts.teardownPayroll({ employeeId }) });

        // Step 3 — grant the annual PTO policy.
        await acts.grantTimeOff({ employeeId });
        compensations.unshift({ name: "revokeTimeOff", run: () => acts.revokeTimeOff({ employeeId }) });

        // Step 4 — provision system access.
        await acts.provisionAccess({ employeeId, email });
        compensations.unshift({ name: "revokeAccess", run: () => acts.revokeAccess({ employeeId }) });

        // Step 5 — activate the employee (onboarding → active). Terminal; no
        // compensation.
        await acts.activateEmployee({ employeeId });
        status = OnboardingStatus.COMPLETED;
    } catch (err) {
        // Unwind in LIFO order; each compensation is isolated so the unwind
        // never throws. Temporal already retried each forward+comp activity.
        log.warn("OnboardingWorkflow failed; compensating", { employeeId, error: String(err) });
        for (const comp of compensations) {
            try {
                await comp.run();
            } catch (compErr) {
                log.error("compensation failed (continuing unwind)", { employeeId, compensation: comp.name, error: String(compErr) });
            }
        }
        status = OnboardingStatus.FAILED;
        // Preserve the original failure so it surfaces in temporal-ui / GetOnboarding.
        if (err instanceof ApplicationFailure) throw err;
        throw ApplicationFailure.create({ message: String(err), type: "OnboardingWorkflowFailed" });
    }

    // Phase 5b — broadcast `EmployeeOnboarded` ONCE on completion. This runs
    // OUTSIDE the compensation scope (the catch above always rethrows, so we are
    // here only on success): a fire-and-forget 1→N broadcast whose failure must
    // NEVER roll back a now-active employee. It is logged and swallowed, never
    // rethrown, so the workflow stays COMPLETED even if the broadcast is lost.
    try {
        await acts.announceOnboarded({ employeeId, name, email, title, department, managerId });
    } catch (err) {
        log.warn("EmployeeOnboarded broadcast failed (onboarding already complete; not rolling back)", { employeeId, error: String(err) });
    }

    return status;
}
