/**
 * The three independent `EmployeeOnboarded` reactors and their in-memory state.
 *
 * Each reactor is a SEPARATE consumer of the ONE `onboarding.employee-onboarded`
 * broadcast:
 *
 *  - WELCOME   — "sends" a welcome email to the new hire.
 *  - AUDIT-LOG — appends one immutable record per onboarded employee.
 *  - HEADCOUNT — tallies active headcount per department.
 *
 * Every reactor binds its OWN handler function to the SAME
 * `OnboardingEventHandlers` service descriptor, but on its OWN bus with its OWN
 * consumer group (built in `broadcastBus.ts`). Reusing one proto service across
 * three buses is fine — the duplicate-topic guard is per-bus — and independence
 * comes from the separate buses + distinct groups, not from separate proto
 * services.
 *
 * IDEMPOTENCY — every reactor dedupes by `employeeId`. On a real broker the
 * broadcast is at-least-once (a worker crash after publish-before-ack re-fires
 * the reactors), and a redelivery would otherwise send a second welcome email or
 * double-count a headcount. Deduping by `employeeId` absorbs the redelivery and
 * also makes the dockerless test deterministic. This is why broadcast reactors
 * are written idempotent (durable/ordered delivery is the saga's job, not the
 * EventBus's).
 *
 * `reset*()` / inspect helpers are the test seams.
 *
 * @module events/reactors
 */

import type { EventRoute } from "@connectum/events";
import { OnboardingEventHandlers } from "#gen/onboarding/v1/onboarding_events_pb.ts";

// ── Welcome reactor ─────────────────────────────────────────────────────────

/** Employee ids already welcomed (idempotency set). */
const welcomeSeen = new Set<string>();
/** The email addresses a welcome was "sent" to (one per distinct employee). */
const sentWelcomes: string[] = [];

/** The list of emails the welcome reactor has sent to (test/inspection helper). */
export function welcomeEmails(): readonly string[] {
    return sentWelcomes;
}

/** Reset the welcome reactor's state — used between tests. */
export function resetWelcome(): void {
    welcomeSeen.clear();
    sentWelcomes.length = 0;
}

/**
 * Welcome route: on each `EmployeeOnboarded`, "send" a welcome email ONCE per
 * `employeeId` (a redelivery is a no-op).
 */
export const welcomeReactorRoutes: EventRoute = (events) => {
    events.service(OnboardingEventHandlers, {
        async onEmployeeOnboarded(event, ctx) {
            if (!welcomeSeen.has(event.employeeId)) {
                welcomeSeen.add(event.employeeId);
                sentWelcomes.push(event.email);
            }
            await ctx.ack();
        },
    });
};

// ── Audit-log reactor ───────────────────────────────────────────────────────

/** One immutable audit record per onboarded employee (the full event shape). */
export interface AuditRecord {
    readonly employeeId: string;
    readonly name: string;
    readonly email: string;
    readonly department: string;
    readonly managerId: string;
}

/** Append-only audit log (one record per distinct `employeeId`). */
const auditLog: AuditRecord[] = [];
/** Employee ids already audited (idempotency set). */
const auditSeen = new Set<string>();

/** The audit records appended so far (test/inspection helper). */
export function auditRecords(): readonly AuditRecord[] {
    return auditLog;
}

/** Reset the audit reactor's state — used between tests. */
export function resetAudit(): void {
    auditLog.length = 0;
    auditSeen.clear();
}

/**
 * Audit route: append one immutable record per `EmployeeOnboarded`, ONCE per
 * `employeeId`. The record mirrors the full documented event shape.
 */
export const auditReactorRoutes: EventRoute = (events) => {
    events.service(OnboardingEventHandlers, {
        async onEmployeeOnboarded(event, ctx) {
            if (!auditSeen.has(event.employeeId)) {
                auditSeen.add(event.employeeId);
                auditLog.push({
                    employeeId: event.employeeId,
                    name: event.name,
                    email: event.email,
                    department: event.department,
                    managerId: event.managerId,
                });
            }
            await ctx.ack();
        },
    });
};

// ── Headcount reactor ───────────────────────────────────────────────────────

/** Employee ids already counted (idempotency set). */
const headcountSeen = new Set<string>();
/** Active headcount per department (department → count). */
const headcountByDept = new Map<string, number>();

/** The current headcount for a department (test/inspection helper). */
export function departmentHeadcount(department: string): number {
    return headcountByDept.get(department) ?? 0;
}

/** Reset the headcount reactor's state — used between tests. */
export function resetHeadcount(): void {
    headcountSeen.clear();
    headcountByDept.clear();
}

/**
 * Headcount route: increment the new hire's department headcount ONCE per
 * `employeeId` (a redelivery is a no-op).
 */
export const headcountReactorRoutes: EventRoute = (events) => {
    events.service(OnboardingEventHandlers, {
        async onEmployeeOnboarded(event, ctx) {
            if (!headcountSeen.has(event.employeeId)) {
                headcountSeen.add(event.employeeId);
                headcountByDept.set(event.department, (headcountByDept.get(event.department) ?? 0) + 1);
            }
            await ctx.ack();
        },
    });
};

// ── Shared test seam ────────────────────────────────────────────────────────

/** Reset all three reactors' state — used between tests. */
export function resetAllReactors(): void {
    resetWelcome();
    resetAudit();
    resetHeadcount();
}
