/**
 * PayrollService — tracks each employee's remaining leave balance.
 *
 * Two surfaces share one in-memory ledger:
 *  - the RPC `GetBalance` (read);
 *  - the event subscriber `PayrollEventHandlers.OnLeaveApproved` (write), which
 *    decrements the balance when TimeOffService approves a leave request.
 *
 * In a monolith both surfaces live in this one process on one EventBus; in the
 * split topology only the payroll process mounts this RPC service *and* the
 * subscriber route (so the broker delivers LeaveApproved here, not elsewhere).
 *
 * @module services/payrollService
 */

import { create } from "@bufbuild/protobuf";
import { defineService } from "@connectum/core";
import type { EventRoute } from "@connectum/events";
import { BalanceSchema, GetBalanceResponseSchema, PayrollEventHandlers, PayrollService } from "#gen/payroll/v1/payroll_pb.ts";

/** Initial leave-days balance per employee (id → days). */
const INITIAL_BALANCE: ReadonlyArray<readonly [string, number]> = [
    ["e-001", 25],
    ["e-002", 25],
    ["e-003", 18],
];

/** Demo leave-balance ledger (employee id → remaining days). */
const balances = new Map<string, number>(INITIAL_BALANCE.map(([id, days]) => [id, days]));

/** Reset the ledger to its initial state — used between tests. */
export function resetBalances(): void {
    balances.clear();
    for (const [id, days] of INITIAL_BALANCE) balances.set(id, days);
}

export const payrollService = defineService(PayrollService, {
    getBalance: (req) =>
        create(GetBalanceResponseSchema, {
            balance: create(BalanceSchema, { employeeId: req.employeeId, remainingDays: balances.get(req.employeeId) ?? 0 }),
        }),
});

/**
 * Event subscriber route: decrement the balance on each LeaveApproved event.
 * Topic comes from the proto `(connectum.events.v1.event).topic` annotation on
 * `OnLeaveApproved` — no topic is configured here.
 */
export const payrollEventRoutes: EventRoute = (events) => {
    events.service(PayrollEventHandlers, {
        async onLeaveApproved(event, ctx) {
            const current = balances.get(event.employeeId) ?? 0;
            balances.set(event.employeeId, Math.max(0, current - event.days));
            await ctx.ack();
        },
    });
};
