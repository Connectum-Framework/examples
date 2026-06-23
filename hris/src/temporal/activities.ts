/**
 * Temporal activities — the onboarding saga's side effects, each a ConnectRPC
 * call.
 *
 * Activities run in the worker's Node process (NOT the deterministic workflow
 * sandbox), so they may freely create ConnectRPC clients and do I/O. Each
 * activity is one RPC against a role service over the network (`*_ADDR`). The
 * workflow (`workflows.ts`) only `proxyActivities` these and never touches a
 * client itself.
 *
 * Activities are grouped:
 *  - forward steps: createEmployee, setupPayroll, grantTimeOff, provisionAccess,
 *    activateEmployee.
 *  - compensations: offboardEmployee, teardownPayroll, revokeTimeOff,
 *    revokeAccess — all IDEMPOTENT (the services no-op on already-undone state),
 *    since a compensation may run after a forward step partially applied.
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
import { ApplicationFailure } from "@temporalio/activity";
import { ProvisionAccessRequestSchema, RevokeAccessRequestSchema } from "#gen/access/v1/access_pb.ts";
import { ActivateEmployeeRequestSchema, CreateEmployeeRequestSchema, GetEmployeeRequestSchema, OffboardEmployeeRequestSchema } from "#gen/directory/v1/directory_pb.ts";
import { SetupPayrollRequestSchema, TeardownPayrollRequestSchema } from "#gen/payroll/v1/payroll_pb.ts";
import { GrantTimeOffRequestSchema, RevokeTimeOffRequestSchema } from "#gen/timeoff/v1/timeoff_pb.ts";
import type { ServiceClients } from "#temporal/clients.ts";
import { createServiceClients } from "#temporal/clients.ts";

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

/** Lazily-built shared clients (one transport set per worker process). */
let sharedClients: ServiceClients | undefined;

/** Get (or build once) the worker's service clients. */
function clients(): ServiceClients {
    if (sharedClients === undefined) {
        sharedClients = createServiceClients();
    }
    return sharedClients;
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
        await clients().directory.createEmployee(
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
            const existing = await clients().directory.getEmployee(create(GetEmployeeRequestSchema, { id: hire.employeeId }));
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
    await clients().directory.offboardEmployee(create(OffboardEmployeeRequestSchema, { id: input.employeeId }));
}

/** Step 2 — enroll the new hire in payroll (initial leave balance). */
export async function setupPayroll(input: { employeeId: string }): Promise<void> {
    await clients().payroll.setupPayroll(create(SetupPayrollRequestSchema, { employeeId: input.employeeId, initialDays: INITIAL_PAYROLL_DAYS }));
}

/** Compensation for step 2 — remove the payroll enrollment. Idempotent. */
export async function teardownPayroll(input: { employeeId: string }): Promise<void> {
    await clients().payroll.teardownPayroll(create(TeardownPayrollRequestSchema, { employeeId: input.employeeId }));
}

/** Step 3 — assign the new hire their annual PTO policy grant. */
export async function grantTimeOff(input: { employeeId: string }): Promise<void> {
    await clients().timeoff.grantTimeOff(create(GrantTimeOffRequestSchema, { employeeId: input.employeeId, policyDays: PTO_POLICY_DAYS }));
}

/** Compensation for step 3 — revoke the PTO policy grant. Idempotent. */
export async function revokeTimeOff(input: { employeeId: string }): Promise<void> {
    await clients().timeoff.revokeTimeOff(create(RevokeTimeOffRequestSchema, { employeeId: input.employeeId }));
}

/** Step 4 — provision system access (the IT account) for the new hire. */
export async function provisionAccess(input: { employeeId: string; email: string }): Promise<void> {
    await clients().access.provisionAccess(create(ProvisionAccessRequestSchema, { employeeId: input.employeeId, email: input.email }));
}

/** Compensation for step 4 — revoke the system account. Idempotent. */
export async function revokeAccess(input: { employeeId: string }): Promise<void> {
    await clients().access.revokeAccess(create(RevokeAccessRequestSchema, { employeeId: input.employeeId }));
}

/**
 * Step 5 — activate the employee (directory status "onboarding" → "active").
 * The terminal happy-path step; no compensation (success is final).
 */
export async function activateEmployee(input: { employeeId: string }): Promise<void> {
    await clients().directory.activateEmployee(create(ActivateEmployeeRequestSchema, { id: input.employeeId }));
}
