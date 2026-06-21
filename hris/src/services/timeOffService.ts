/**
 * TimeOffService — approves leave requests, composing two framework primitives.
 *
 *  1. `ctx.call("directory.v1.DirectoryService/GetEmployee", …)` validates that
 *     the employee exists. The transport is chosen by the framework: in-process
 *     when DirectoryService is mounted locally (monolith), or over the network
 *     via the `remoteResolver` when it lives in another process (split) — the
 *     handler code is identical either way. A `Code.NotFound` from the directory
 *     propagates straight back to the caller.
 *  2. After approval, it publishes a `LeaveApproved` event on the injected
 *     EventBus. PayrollService consumes it and decrements the balance.
 *
 * The bus is injected (`makeTimeOffService(bus)`) rather than imported as a
 * module singleton so the publisher and the payroll subscriber share the SAME
 * bus instance in a monolith — a MemoryAdapter keeps its subscriptions in a
 * closure, so two bus instances would never cross-deliver.
 *
 * @module services/timeOffService
 */

import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { defineService, type ServiceDefinition } from "@connectum/core";
import type { EventBus } from "@connectum/events";
import { GetEmployeeRequestSchema } from "#gen/directory/v1/directory_pb.ts";
import { LeaveApprovedSchema } from "#gen/payroll/v1/payroll_pb.ts";
import { GrantTimeOffResponseSchema, LeaveRequestSchema, RequestLeaveResponseSchema, TimeOffGrantSchema, TimeOffService } from "#gen/timeoff/v1/timeoff_pb.ts";
import { LEAVE_APPROVED_TOPIC } from "#events.ts";
import { empty } from "#empty.ts";

/**
 * PTO policy-grant ledger (employee id → annual allotment in days). Distinct
 * from PayrollService's decrementable leave BALANCE — this is the entitlement
 * assigned at onboarding. Module-level so the onboarding saga's GrantTimeOff /
 * RevokeTimeOff share it regardless of which `makeTimeOffService` instance runs.
 */
const grants = new Map<string, number>();

/** Reset the PTO grant ledger — used between tests. */
export function resetGrants(): void {
    grants.clear();
}

/** Read an employee's PTO policy grant in days (test/inspection helper). */
export function timeOffGrant(employeeId: string): number | undefined {
    return grants.get(employeeId);
}

/**
 * Build the TimeOffService definition bound to a specific EventBus instance.
 *
 * @param eventBus - The bus this handler publishes LeaveApproved on.
 */
export function makeTimeOffService(eventBus: EventBus): ServiceDefinition {
    return defineService(TimeOffService, {
        async requestLeave(req, ctx) {
            // Cross-service call — typed by the generated catalog. Throws
            // Code.NotFound (from DirectoryService) for an unknown employee;
            // that ConnectError propagates to the caller unchanged.
            await ctx.call("directory.v1.DirectoryService/GetEmployee", create(GetEmployeeRequestSchema, { id: req.employeeId }));

            const leaveRequestId = `lr-${randomUUID()}`;

            // Approved — publish the integration event. The topic is passed
            // explicitly so the publisher needs no subscriber routes of its own
            // (it has none in split mode).
            await eventBus.publish(LeaveApprovedSchema, create(LeaveApprovedSchema, { leaveRequestId, employeeId: req.employeeId, days: req.days }), {
                topic: LEAVE_APPROVED_TOPIC,
            });

            return create(RequestLeaveResponseSchema, {
                leaveRequest: create(LeaveRequestSchema, { id: leaveRequestId, status: "APPROVED" }),
            });
        },

        // Onboarding saga step 3 — assign the new hire their annual PTO policy
        // allotment. Idempotent: re-granting keeps the existing grant.
        grantTimeOff(req) {
            if (!grants.has(req.employeeId)) {
                grants.set(req.employeeId, req.policyDays);
            }
            return create(GrantTimeOffResponseSchema, {
                grant: create(TimeOffGrantSchema, { employeeId: req.employeeId, policyDays: grants.get(req.employeeId) ?? 0 }),
            });
        },

        // Compensation for step 3 — revoke the PTO grant. Idempotent: a no-op
        // success for an unknown employee.
        revokeTimeOff(req) {
            grants.delete(req.employeeId);
            return empty();
        },
    });
}
