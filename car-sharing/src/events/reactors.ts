/**
 * The three independent `TripCompleted` reactors and their in-memory state.
 *
 * Each reactor is a SEPARATE consumer of the ONE `trips.completed` broadcast:
 *
 *  - PRICING / ANALYTICS — tallies trip count + total settled revenue.
 *  - AUDIT-LOG          — appends one immutable record per settled trip.
 *  - NOTIFICATIONS      — "sends" a receipt to the renter.
 *
 * Every reactor binds its OWN handler function to the SAME `TripEventHandlers`
 * service descriptor, but on its OWN bus with its OWN consumer group (built in
 * `eventBus.ts`). Reusing one proto service across three buses is fine — the
 * duplicate-topic guard is per-bus — and independence comes from the separate
 * buses + distinct groups, not from separate proto services.
 *
 * IDEMPOTENCY — every reactor dedupes by `tripId`. On a real broker the
 * broadcast is at-least-once (a worker crash after publish-before-ack re-fires
 * the reactors), and a redelivery would otherwise double-count an analytics
 * tally or send a second receipt. Deduping by `tripId` absorbs the redelivery
 * and also makes the dockerless test deterministic. This is the reason broadcast
 * reactors are written idempotent (durable/ordered delivery is Temporal's job,
 * not the EventBus's).
 *
 * `reset*()` / inspect helpers are the test seams (mirroring the billing/payroll
 * services' `reset*`/count helpers).
 *
 * @module events/reactors
 */

import type { EventRoute } from "@connectum/events";
import type { TripCompleted } from "#gen/trips/v1/trip_events_pb.ts";
import { TripEventHandlers } from "#gen/trips/v1/trip_events_pb.ts";

// ── Pricing / analytics reactor ─────────────────────────────────────────────

/** Trip ids already counted by the pricing reactor (idempotency set). */
const pricingSeen = new Set<string>();
/** Running tally of settled trips (deduped by `tripId`). */
let pricingTripCount = 0;
/** Running tally of settled revenue in minor units (cents). */
let pricingRevenueCents = 0n;

/** Number of distinct trips the pricing reactor has tallied. */
export function pricingTripCountValue(): number {
    return pricingTripCount;
}

/** Total settled revenue (cents) the pricing reactor has accumulated. */
export function pricingRevenueCentsValue(): bigint {
    return pricingRevenueCents;
}

/** Reset the pricing reactor's state — used between tests. */
export function resetPricing(): void {
    pricingSeen.clear();
    pricingTripCount = 0;
    pricingRevenueCents = 0n;
}

/**
 * Pricing/analytics route: on each `TripCompleted`, tally the trip and its
 * revenue ONCE per `tripId` (a redelivery is a no-op).
 */
export const pricingReactorRoutes: EventRoute = (events) => {
    events.service(TripEventHandlers, {
        async onTripCompleted(event, ctx) {
            if (!pricingSeen.has(event.tripId)) {
                pricingSeen.add(event.tripId);
                pricingTripCount += 1;
                pricingRevenueCents += event.amountCents;
            }
            await ctx.ack();
        },
    });
};

// ── Audit-log reactor ───────────────────────────────────────────────────────

/** One immutable audit record per settled trip (the full event shape). */
export interface AuditRecord {
    readonly tripId: string;
    readonly userId: string;
    readonly vehicleId: string;
    readonly amountCents: bigint;
    readonly durationMs: bigint;
}

/** Append-only audit log (one record per distinct `tripId`). */
const auditLog: AuditRecord[] = [];
/** Trip ids already audited (idempotency set). */
const auditSeen = new Set<string>();

/** A snapshot copy of the audit log (newest last). */
export function auditRecords(): readonly AuditRecord[] {
    return [...auditLog];
}

/** Reset the audit reactor's state — used between tests. */
export function resetAudit(): void {
    auditLog.length = 0;
    auditSeen.clear();
}

/**
 * Audit-log route: append the FULL `TripCompleted` shape ONCE per `tripId`. The
 * record is the documented contract (all five fields), so it doubles as the
 * end-to-end shape oracle in the broadcast test.
 */
export const auditReactorRoutes: EventRoute = (events) => {
    events.service(TripEventHandlers, {
        async onTripCompleted(event: TripCompleted, ctx) {
            if (!auditSeen.has(event.tripId)) {
                auditSeen.add(event.tripId);
                auditLog.push({
                    tripId: event.tripId,
                    userId: event.userId,
                    vehicleId: event.vehicleId,
                    amountCents: event.amountCents,
                    durationMs: event.durationMs,
                });
            }
            await ctx.ack();
        },
    });
};

// ── Notifications reactor ───────────────────────────────────────────────────

/** A "sent" receipt notification (who it targeted + the charged amount). */
export interface SentNotification {
    readonly tripId: string;
    readonly userId: string;
    readonly amountCents: bigint;
}

/** Receipts the notifications reactor has "sent" (one per distinct `tripId`). */
const sentNotifications: SentNotification[] = [];
/** Trip ids already notified (idempotency set). */
const notifySeen = new Set<string>();

/** A snapshot copy of the receipts the notifications reactor has sent. */
export function sentReceipts(): readonly SentNotification[] {
    return [...sentNotifications];
}

/** Reset the notifications reactor's state — used between tests. */
export function resetNotify(): void {
    sentNotifications.length = 0;
    notifySeen.clear();
}

/**
 * Notifications route: "send" a receipt to the renter ONCE per `tripId`. A
 * redelivery must NOT send a second receipt — hence the idempotency set.
 */
export const notifyReactorRoutes: EventRoute = (events) => {
    events.service(TripEventHandlers, {
        async onTripCompleted(event, ctx) {
            if (!notifySeen.has(event.tripId)) {
                notifySeen.add(event.tripId);
                sentNotifications.push({ tripId: event.tripId, userId: event.userId, amountCents: event.amountCents });
            }
            await ctx.ack();
        },
    });
};

// ── Combined reset (test convenience) ───────────────────────────────────────

/** Reset all three reactors' in-memory state. */
export function resetAllReactors(): void {
    resetPricing();
    resetAudit();
    resetNotify();
}
