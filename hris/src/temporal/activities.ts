/**
 * Temporal activities — the onboarding saga's side effects, each a ConnectRPC
 * call.
 *
 * Activities run in the worker's Node process (NOT the deterministic workflow
 * sandbox), so they may freely use network clients and do I/O. Each activity is
 * one `client.call("<typeName>/<Method>", req)` against a role service over the
 * network (`*_ADDR`), typed by the same generated catalog as `ctx.call`. The
 * workflow (`workflows.ts`) only `proxyActivities` these and never touches a
 * client itself.
 *
 * Activities are grouped:
 *  - forward steps: createEmployee, setupPayroll, grantTimeOff, provisionAccess,
 *    activateEmployee.
 *  - compensations: offboardEmployee, teardownPayroll, revokeTimeOff,
 *    revokeAccess — all IDEMPOTENT (the services no-op on already-undone state),
 *    since a compensation may run after a forward step partially applied.
 *  - announcement: announceOnboarded — publishes `EmployeeOnboarded` on the
 *    EventBus after the saga has completed (not a saga step; no compensation).
 *
 * The business failure of the very first step (the employee id is already taken)
 * is rethrown as a NON-RETRYABLE `ApplicationFailure` so Temporal fails the
 * workflow fast (no pointless retries, no compensation — nothing was created).
 * Transient/infra failures of every other step stay retryable, which is the
 * whole point of the durable saga, so they are NOT marked non-retryable here.
 *
 * @module temporal/activities
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { CatalogClient } from "@connectum/core";
import { ApplicationFailure } from "@temporalio/activity";
import { ProvisionAccessRequestSchema, RevokeAccessRequestSchema } from "#gen/access/v1/access_pb.ts";
import { ActivateEmployeeRequestSchema, CreateEmployeeRequestSchema, GetEmployeeRequestSchema, OffboardEmployeeRequestSchema } from "#gen/directory/v1/directory_pb.ts";
import { EmployeeOnboardedSchema } from "#gen/onboarding/v1/onboarding_events_pb.ts";
import { SetupPayrollRequestSchema, TeardownPayrollRequestSchema } from "#gen/payroll/v1/payroll_pb.ts";
import { GrantTimeOffRequestSchema, RevokeTimeOffRequestSchema } from "#gen/timeoff/v1/timeoff_pb.ts";
import { createWorkerClient } from "#temporal/clients.ts";
import { onboardedPublisher } from "#temporal/publisher.ts";

/**
 * Error type for a non-retryable, business failure of step 1. The workflow
 * lists this string in `nonRetryableErrorTypes` (by the SAME literal value) and
 * surfaces it as a terminal workflow failure (preserving the ALREADY_EXISTS
 * meaning).
 *
 * NOT exported: only used inside this module, and keeping the activities
 * namespace function-only (so `import * as activities` passed to `Worker.create`
 * carries no non-function entry).
 */
const EMPLOYEE_EXISTS = "EmployeeExists" as const;

/** Initial leave-days balance a new hire is enrolled with (demo policy). */
const INITIAL_PAYROLL_DAYS = 25;
/** Annual PTO policy allotment granted on onboarding (demo policy). */
const PTO_POLICY_DAYS = 25;

/**
 * Lazily-built shared catalog client. Built on first use rather than at import,
 * so the `*_ADDR` variables are read when the worker actually runs an activity
 * (the tests set them after importing this module).
 */
let sharedClient: CatalogClient | undefined;

/** Get (or build once) the worker's catalog client. */
function client(): CatalogClient {
    if (sharedClient === undefined) {
        sharedClient = createWorkerClient();
    }
    return sharedClient;
}

/** Details of the new hire threaded through the forward steps. */
export interface NewHire {
    readonly employeeId: string;
    readonly name: string;
    readonly email: string;
    readonly title: string;
    readonly department: string;
    readonly managerId: string;
}

// ── Forward steps ─────────────────────────────────────────────────────────

/**
 * Step 1 — create the directory row (status "onboarding"). Idempotent across
 * Temporal retries: on `Code.AlreadyExists` it reads the existing row back and,
 * if it matches this hire, treats it as success (a retry that observed its OWN
 * prior commit) rather than a failure. A row that DIFFERS under the same id is a
 * genuine duplicate-id conflict, rethrown as a NON-RETRYABLE
 * `ApplicationFailure(EMPLOYEE_EXISTS)` so the workflow fails fast with no
 * compensation; any other (infra) error stays retryable.
 *
 * @param hire - The {@link NewHire} details.
 */
export async function createEmployee(hire: NewHire): Promise<void> {
    try {
        await client().call(
            "directory.v1.DirectoryService/CreateEmployee",
            create(CreateEmployeeRequestSchema, {
                id: hire.employeeId,
                name: hire.name,
                email: hire.email,
                title: hire.title,
                department: hire.department,
                managerId: hire.managerId,
            }),
        );
    } catch (err) {
        if (err instanceof ConnectError && err.code === Code.AlreadyExists) {
            // Read-back equivalence: a retry may observe its own prior commit.
            // If the stored row matches this hire, the create already succeeded.
            const existing = await client().call("directory.v1.DirectoryService/GetEmployee", create(GetEmployeeRequestSchema, { id: hire.employeeId }));
            const e = existing.employee;
            if (e !== undefined && e.name === hire.name && e.email === hire.email && e.title === hire.title && e.department === hire.department && e.managerId === hire.managerId) {
                return;
            }
            // A genuinely different employee already owns this id → terminal.
            throw ApplicationFailure.create({
                message: err.message,
                type: EMPLOYEE_EXISTS,
                nonRetryable: true,
            });
        }
        throw err;
    }
}

/** Compensation for step 1 — mark the directory row "offboarded". Idempotent. */
export async function offboardEmployee(input: { employeeId: string }): Promise<void> {
    await client().call("directory.v1.DirectoryService/OffboardEmployee", create(OffboardEmployeeRequestSchema, { id: input.employeeId }));
}

/** Step 2 — enroll the new hire in payroll (initial leave balance). */
export async function setupPayroll(input: { employeeId: string }): Promise<void> {
    await client().call("payroll.v1.PayrollService/SetupPayroll", create(SetupPayrollRequestSchema, { employeeId: input.employeeId, initialDays: INITIAL_PAYROLL_DAYS }));
}

/** Compensation for step 2 — remove the payroll enrollment. Idempotent. */
export async function teardownPayroll(input: { employeeId: string }): Promise<void> {
    await client().call("payroll.v1.PayrollService/TeardownPayroll", create(TeardownPayrollRequestSchema, { employeeId: input.employeeId }));
}

/** Step 3 — assign the new hire their annual PTO policy grant. */
export async function grantTimeOff(input: { employeeId: string }): Promise<void> {
    await client().call("timeoff.v1.TimeOffService/GrantTimeOff", create(GrantTimeOffRequestSchema, { employeeId: input.employeeId, policyDays: PTO_POLICY_DAYS }));
}

/** Compensation for step 3 — revoke the PTO policy grant. Idempotent. */
export async function revokeTimeOff(input: { employeeId: string }): Promise<void> {
    await client().call("timeoff.v1.TimeOffService/RevokeTimeOff", create(RevokeTimeOffRequestSchema, { employeeId: input.employeeId }));
}

/** Step 4 — provision system access (the IT account) for the new hire. */
export async function provisionAccess(input: { employeeId: string; email: string }): Promise<void> {
    await client().call("access.v1.AccessService/ProvisionAccess", create(ProvisionAccessRequestSchema, { employeeId: input.employeeId, email: input.email }));
}

/** Compensation for step 4 — revoke the system account. Idempotent. */
export async function revokeAccess(input: { employeeId: string }): Promise<void> {
    await client().call("access.v1.AccessService/RevokeAccess", create(RevokeAccessRequestSchema, { employeeId: input.employeeId }));
}

/**
 * Step 5 — activate the employee (directory status "onboarding" → "active").
 * The terminal happy-path step; no compensation (success is final).
 */
export async function activateEmployee(input: { employeeId: string }): Promise<void> {
    await client().call("directory.v1.DirectoryService/ActivateEmployee", create(ActivateEmployeeRequestSchema, { id: input.employeeId }));
}

/**
 * After the saga completes — broadcast `EmployeeOnboarded` to the reactors
 * (welcome, audit, headcount). This announces a fact that is already final; it
 * is not a saga step, registers no compensation, and the workflow tolerates its
 * failure. The topic comes from the proto option through the publisher bus's
 * `publishes` declaration, so no raw topic is passed here.
 *
 * @param hire - The {@link NewHire} details, carried into the event.
 */
export async function announceOnboarded(hire: NewHire): Promise<void> {
    await onboardedPublisher().publish(
        EmployeeOnboardedSchema,
        create(EmployeeOnboardedSchema, {
            employeeId: hire.employeeId,
            name: hire.name,
            email: hire.email,
            department: hire.department,
            managerId: hire.managerId,
        }),
    );
}
