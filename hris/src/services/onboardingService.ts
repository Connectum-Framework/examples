/**
 * OnboardingService — the edge orchestrator, backed by a durable Temporal saga.
 *
 *  - `OnboardEmployee` runs a SYNCHRONOUS availability pre-check via
 *    `ctx.call("directory.v1.DirectoryService/GetEmployee", …)`. Unlike the
 *    car-sharing trip pre-check (which requires the vehicle to EXIST), this one
 *    is INVERTED: the employee id must be FREE. A directory hit → the id is
 *    taken → `Code.AlreadyExists`; a `Code.NotFound` → the id is free, proceed.
 *    Any OTHER error (e.g. the directory is `Code.Unavailable`) PROPAGATES — it
 *    is not treated as "free to go". Only AFTER the pre-check passes does it
 *    START the durable `OnboardingWorkflow` and return `{ onboarding: { …,
 *    status: STARTED }, workflowId }`. The long-running saga (create → payroll →
 *    timeoff → access → activate, with automatic compensation) runs in Temporal,
 *    not in this handler — and because the pre-check runs first, the error path
 *    needs no live Temporal.
 *  - `GetOnboarding` reads LIVE status from the workflow via a Temporal Workflow
 *    Query (`handle.query(getOnboardingStatusQuery)`), falling back to a terminal
 *    status derived from `handle.describe()` once the workflow has closed.
 *
 * The Temporal client is INJECTED via the {@link createOnboardingService}
 * factory, so the server supplies a lazy `@temporalio/client` `WorkflowClient` in
 * production and tests inject a stub. When no client is configured (a non-
 * onboarding role, or the server-only e2e), `OnboardEmployee`'s workflow start
 * and `GetOnboarding` raise `Code.Unavailable` — but the pre-check still runs
 * first, so the error-path e2e needs no live Temporal.
 *
 * @module services/onboardingService
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ServiceDefinition } from "@connectum/core";
import { defineService } from "@connectum/core";
import { QueryNotRegisteredError, QueryRejectedError, WorkflowNotFoundError } from "@temporalio/client";
import { GetEmployeeRequestSchema } from "#gen/directory/v1/directory_pb.ts";
import { GetOnboardingResponseSchema, OnboardEmployeeResponseSchema, OnboardingSchema, OnboardingService } from "#gen/onboarding/v1/onboarding_pb.ts";
import type { OnboardingStatus as OnboardingStatusT } from "#temporal/onboardingStatus.ts";
import { OnboardingStatus } from "#temporal/onboardingStatus.ts";
import type { OnboardingWorkflowInput } from "#temporal/workflows.ts";

// ── Temporal client port ────────────────────────────────────────────────────
// A minimal structural interface over the `@temporalio/client` `WorkflowClient`
// the handler actually uses. Typing against a port (not the concrete class)
// keeps the service import-light and lets tests inject a stub. The real
// `WorkflowClient` satisfies this shape.

/** A handle subset: query the live status and describe the (possibly closed) run. */
export interface OnboardingWorkflowHandle {
    query<Ret>(queryName: string): Promise<Ret>;
    describe(): Promise<{ status: { name: string } }>;
}

/** The Temporal client subset the onboarding handler depends on. */
export interface OnboardingWorkflowClient {
    start(workflowType: string, options: { taskQueue: string; workflowId: string; args: [OnboardingWorkflowInput] }): Promise<{ workflowId: string }>;
    getHandle(workflowId: string): OnboardingWorkflowHandle;
}

/** Options for {@link createOnboardingService}. */
export interface OnboardingServiceOptions {
    /**
     * Temporal client used to start the saga and read status. Optional: when
     * absent, the pre-check still runs, but starting the workflow / reading
     * status raises `Code.Unavailable` (so non-onboarding roles and the
     * server-only e2e build and run without Temporal).
     */
    readonly workflowClient?: OnboardingWorkflowClient;
    /** Task queue to start workflows on. */
    readonly taskQueue: string;
}

/** Map a closed-workflow status name to a terminal onboarding status. */
function terminalStatusFor(workflowStatusName: string): OnboardingStatusT {
    // A completed saga activated the employee; anything else (FAILED/CANCELLED/
    // TERMINATED/TIMED_OUT) means the saga unwound.
    return workflowStatusName === "COMPLETED" ? OnboardingStatus.COMPLETED : OnboardingStatus.FAILED;
}

/**
 * True when a failed Query legitimately means "the run is closed/gone or its
 * query handler is unavailable" — the only cases where falling back to a
 * terminal status from `describe()` is correct. A transient/other error must
 * NOT be collapsed into a terminal status (it is surfaced as `Unavailable`).
 */
function isClosedOrMissingRun(err: unknown): boolean {
    return err instanceof WorkflowNotFoundError || err instanceof QueryNotRegisteredError || err instanceof QueryRejectedError;
}

/**
 * Build the OnboardingService definition with an injected Temporal client.
 *
 * @param options - {@link OnboardingServiceOptions}.
 */
export function createOnboardingService(options: OnboardingServiceOptions): ServiceDefinition {
    const { workflowClient, taskQueue } = options;

    return defineService(OnboardingService, {
        async onboardEmployee(req, ctx) {
            // INVERTED availability pre-check — the employee id must be FREE.
            // A directory hit means the id is taken (AlreadyExists); a NotFound
            // means it is free (proceed). Any OTHER error propagates unchanged —
            // an Unavailable directory is NOT treated as "free to go". This runs
            // BEFORE any Temporal use, so the error path needs no live Temporal.
            try {
                await ctx.call("directory.v1.DirectoryService/GetEmployee", create(GetEmployeeRequestSchema, { id: req.employeeId }));
                // The call resolved → the employee already exists.
                throw new ConnectError(`Employee "${req.employeeId}" already exists.`, Code.AlreadyExists);
            } catch (err) {
                if (err instanceof ConnectError && err.code === Code.NotFound) {
                    // Free id — fall through to start the workflow.
                } else {
                    // AlreadyExists (raised above) and any other error (e.g.
                    // Unavailable) propagate unchanged.
                    throw err;
                }
            }

            if (workflowClient === undefined) {
                throw new ConnectError("Temporal is not configured — cannot start the onboarding workflow.", Code.Unavailable);
            }

            // The workflow id IS the employee id, so GetOnboarding can map an
            // employee id straight to its workflow.
            const handle = await workflowClient.start("OnboardingWorkflow", {
                taskQueue,
                workflowId: req.employeeId,
                args: [{ employeeId: req.employeeId, name: req.name, email: req.email, title: req.title, department: req.department, managerId: req.managerId }],
            });

            return create(OnboardEmployeeResponseSchema, {
                onboarding: create(OnboardingSchema, { employeeId: req.employeeId, status: OnboardingStatus.STARTED }),
                workflowId: handle.workflowId,
            });
        },

        async getOnboarding(req) {
            if (workflowClient === undefined) {
                throw new ConnectError("Temporal is not configured — cannot read onboarding status.", Code.Unavailable);
            }

            const handle = workflowClient.getHandle(req.employeeId);

            // Prefer the LIVE status from the running workflow's Query. Only when
            // the Query is unavailable because the run is closed/gone or its
            // query handler isn't registered do we fall back to a terminal status
            // from describe(). A transient/other failure is surfaced as
            // Unavailable, never silently mapped to a terminal status.
            let status: OnboardingStatusT;
            try {
                status = await handle.query<OnboardingStatusT>("getOnboardingStatus");
            } catch (err) {
                if (!isClosedOrMissingRun(err)) {
                    throw new ConnectError(`Could not read onboarding status for "${req.employeeId}".`, Code.Unavailable);
                }
                const description = await handle.describe();
                status = terminalStatusFor(description.status.name);
            }

            return create(GetOnboardingResponseSchema, {
                onboarding: create(OnboardingSchema, { employeeId: req.employeeId, status }),
            });
        },
    });
}
