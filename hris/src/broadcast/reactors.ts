/**
 * The three independent `EmployeeOnboarded` reactors and their in-memory state.
 *
 *  - WELCOME   — "sends" a welcome email to the new hire.
 *  - AUDIT     — appends one immutable record per onboarded employee.
 *  - HEADCOUNT — tallies the headcount per department.
 *
 * Every reactor binds its own handler to the SAME `OnboardingEventHandlers`
 * descriptor. That is fine because each one runs on its own bus under its own
 * consumer group (see `broadcast/buses.ts`); independence comes from the
 * separate buses and groups, not from separate proto services.
 *
 * Every reactor dedupes by `employeeId`. On a broker the broadcast is
 * at-least-once: the worker's publish activity may be retried after the event
 * already went out, and a redelivery would otherwise send a second welcome email
 * or count the same hire twice.
 *
 * The state lives in module memory, which is enough for a demo; the `reset*()`
 * and inspection helpers exist for the tests.
 *
 * @module broadcast/reactors
 */

import type { EventRoute } from "@connectum/events";
import { OnboardingEventHandlers } from "#gen/onboarding/v1/onboarding_events_pb.ts";

/**
 * Each reactor's consumer group. They MUST differ: reactors sharing a group
 * would split the events between them instead of each receiving all of them.
 */
export const REACTOR_GROUP = {
    welcome: "hris-welcome",
    audit: "hris-audit",
    headcount: "hris-headcount",
} as const;

/** One of the reactor names (`welcome` | `audit` | `headcount`). */
export type ReactorKey = keyof typeof REACTOR_GROUP;

/** Every reactor, in a stable order (the default set a reactor process hosts). */
export const ALL_REACTORS: readonly ReactorKey[] = ["welcome", "audit", "headcount"];

/** Narrow an arbitrary string (e.g. from env) to a reactor name. */
export function isReactorKey(value: string): value is ReactorKey {
    return Object.hasOwn(REACTOR_GROUP, value);
}

// ── Welcome reactor ─────────────────────────────────────────────────────────

const welcomed = new Set<string>();
const sentWelcomes: string[] = [];

/** The addresses a welcome was "sent" to, one per distinct employee. */
export function welcomeEmails(): readonly string[] {
    return sentWelcomes;
}

const welcomeRoutes: EventRoute = (events) => {
    events.service(OnboardingEventHandlers, {
        async onEmployeeOnboarded(event, ctx) {
            if (!welcomed.has(event.employeeId)) {
                welcomed.add(event.employeeId);
                sentWelcomes.push(event.email);
            }
            await ctx.ack();
        },
    });
};

// ── Audit reactor ───────────────────────────────────────────────────────────

/** One immutable audit record per onboarded employee — the full event shape. */
export interface AuditRecord {
    readonly employeeId: string;
    readonly name: string;
    readonly email: string;
    readonly department: string;
    readonly managerId: string;
}

const audited = new Set<string>();
const auditLog: AuditRecord[] = [];

/** The audit records appended so far, one per distinct employee. */
export function auditRecords(): readonly AuditRecord[] {
    return auditLog;
}

const auditRoutes: EventRoute = (events) => {
    events.service(OnboardingEventHandlers, {
        async onEmployeeOnboarded(event, ctx) {
            if (!audited.has(event.employeeId)) {
                audited.add(event.employeeId);
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

const counted = new Set<string>();
const headcountByDepartment = new Map<string, number>();

/** The current headcount the reactor has tallied for a department. */
export function departmentHeadcount(department: string): number {
    return headcountByDepartment.get(department) ?? 0;
}

const headcountRoutes: EventRoute = (events) => {
    events.service(OnboardingEventHandlers, {
        async onEmployeeOnboarded(event, ctx) {
            if (!counted.has(event.employeeId)) {
                counted.add(event.employeeId);
                headcountByDepartment.set(event.department, departmentHeadcount(event.department) + 1);
            }
            await ctx.ack();
        },
    });
};

// ── Wiring ──────────────────────────────────────────────────────────────────

/** Each reactor's event route, keyed by reactor name. */
export const REACTOR_ROUTES: Readonly<Record<ReactorKey, EventRoute>> = {
    welcome: welcomeRoutes,
    audit: auditRoutes,
    headcount: headcountRoutes,
};

/** Clear every reactor's state — used between tests. */
export function resetReactors(): void {
    welcomed.clear();
    sentWelcomes.length = 0;
    audited.clear();
    auditLog.length = 0;
    counted.clear();
    headcountByDepartment.clear();
}
