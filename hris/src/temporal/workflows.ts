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
 * Saga (compensation-stack pattern): run the forward steps in order, registering
 * each step's compensation on a LIFO stack — BEFORE the forward call (steps 2-4),
 * so an ambiguous failure that DID commit the side effect is still unwound, or
 * AFTER for step 1 (a failed create committed nothing, and a retry that observed
 * its own commit is reconciled in the activity). On ANY failure, run the
 * compensations in LIFO order (each wrapped in its own try/catch so the unwind
 * never throws), then rethrow the original error. The result:
 *   - provisionAccess fails → revokeAccess → revokeTimeOff → teardownPayroll → offboardEmployee
 *   - grantTimeOff fails    → revokeTimeOff → teardownPayroll → offboardEmployee
 *   - setupPayroll fails    → teardownPayroll → offboardEmployee
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

    // LIFO compensation stack: each step registers its compensation here, BEFORE
    // its forward call (steps 2-4) so an ambiguous failure that committed the
    // side effect is still unwound, or AFTER for step 1.
    const compensations: Compensation[] = [];

    try {
        // Step 1 — create the directory row. A business failure here (the id is
        // already taken) is non-retryable and fails the workflow fast; registered
        // AFTER, since a failed create committed nothing to offboard (and the
        // activity reconciles a retry that observed its own prior commit).
        await acts.createEmployee({ employeeId, name, email, title, department, managerId });
        compensations.unshift({ name: "offboardEmployee", run: () => acts.offboardEmployee({ employeeId }) });

        // Step 2 — enroll in payroll. Register the teardown BEFORE the call:
        // teardownPayroll is idempotent (a no-op if enrollment never committed),
        // so an ambiguous setupPayroll failure is still unwound.
        compensations.unshift({ name: "teardownPayroll", run: () => acts.teardownPayroll({ employeeId }) });
        await acts.setupPayroll({ employeeId });

        // Step 3 — grant the annual PTO policy. Register the revoke BEFORE the
        // call (revokeTimeOff is a no-op if the grant never committed).
        compensations.unshift({ name: "revokeTimeOff", run: () => acts.revokeTimeOff({ employeeId }) });
        await acts.grantTimeOff({ employeeId });

        // Step 4 — provision system access. Register the revoke BEFORE the call
        // (revokeAccess is a no-op if the account was never created).
        compensations.unshift({ name: "revokeAccess", run: () => acts.revokeAccess({ employeeId }) });
        await acts.provisionAccess({ employeeId, email });

        // Step 5 — activate the employee (onboarding → active). Terminal; no
        // compensation.
        await acts.activateEmployee({ employeeId });
        status = OnboardingStatus.COMPLETED;

        return status;
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
}
