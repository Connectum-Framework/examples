/**
 * EventBus factories for the Phase 3 broadcast — ONE publisher, THREE reactors.
 *
 * Phase 3 adds the third orthogonal interaction mechanism to the example:
 * fire-and-forget 1→N broadcast (`ctx.call` is sync RPC; the Temporal saga is
 * durable orchestration). The single domain fact "a trip was settled" is
 * published ONCE as `TripCompleted` and consumed INDEPENDENTLY by three
 * reactors. EventBus is used for BROADCAST only — never orchestration.
 *
 * The fan-out is achieved with FOUR separate buses, not one bus with three
 * handlers:
 *
 *  - the PUBLISHER bus is publish-only (`routes: []`, `publishes:
 *    [TripEventHandlers]`). Listing the event service in `publishes` populates
 *    the publish-topic lookup from the proto `(connectum.events.v1.event).topic`
 *    option, so `publish(TripCompletedSchema, …)` resolves `trips.completed`
 *    with NO raw `{topic}` hand-passed. This is the whole point of `publishes`:
 *    a pure publisher has no subscriber routes, so without it the topic would
 *    silently fall back to the message `typeName`.
 *  - each REACTOR bus has ONE route and its OWN DISTINCT consumer group. Two
 *    routes resolving to the same topic CANNOT share one bus (the duplicate-
 *    topic guard throws at `start()`), so three reactors on `trips.completed`
 *    are FORCED onto three buses. On a real broker, distinct groups give
 *    distinct durable consumers → each gets every event = fan-out. A shared
 *    group would load-balance (one reactor steals each event) = queue.
 *
 * The adapter is pluggable: NATS by default (`NATS_URL`), but tests pass ONE
 * shared `MemoryAdapter()` to all four buses so a single publish reaches all
 * three reactors in-process with no broker (MemoryAdapter broadcasts to every
 * matching subscription and ignores group; the distinct groups are still
 * written so the SAME wiring fans out on NATS).
 *
 * @module events/eventBus
 */

import { createEventBus } from "@connectum/events";
import type { EventAdapter, EventBus, EventRoute } from "@connectum/events";
import type { EventBusLike } from "@connectum/core";
import { NatsAdapter } from "@connectum/events-nats";
import { TripEventHandlers } from "#gen/trips/v1/trip_events_pb.ts";

/** A reactor's stable identity: which side effect + which consumer group. */
export const REACTOR_GROUP = {
    /** Pricing / analytics reactor — tallies trip count + revenue. */
    pricing: "cs-pricing",
    /** Audit-log reactor — appends one immutable record per settled trip. */
    audit: "cs-audit",
    /** Notifications reactor — "sends" a receipt to the renter. */
    notify: "cs-notify",
} as const;

/** One of the reactor selector keys (`pricing` | `audit` | `notify`). */
export type ReactorKey = keyof typeof REACTOR_GROUP;

/** A bus that can both `publish` (the `EventBus` API) and start/stop (`EventBusLike`). */
export type ManagedBus = EventBus & EventBusLike;

/** Default NATS JetStream stream for the example's broadcast topic. */
const NATS_STREAM = "car-sharing";

/**
 * Build the NATS adapter for a process, reading `NATS_URL` (default
 * `nats://localhost:4222`). One adapter instance per bus in the split topology,
 * so each reactor owns an independent broker connection + durable consumer.
 */
function natsAdapter(): EventAdapter {
    return NatsAdapter({ servers: process.env.NATS_URL ?? "nats://localhost:4222", stream: NATS_STREAM });
}

/**
 * Build the PUBLISH-ONLY bus that the worker (the saga's terminal activity) uses
 * to broadcast `TripCompleted`.
 *
 * It has NO routes and lists `TripEventHandlers` in `publishes`, so the topic
 * `trips.completed` is resolved from the proto option — the publisher passes NO
 * raw topic.
 *
 * @param options.adapter - Adapter override (tests pass a shared `MemoryAdapter()`);
 *   defaults to a NATS adapter from `NATS_URL`.
 */
export function buildPublisherBus(options: { readonly adapter?: EventAdapter } = {}): ManagedBus {
    return createEventBus({
        adapter: options.adapter ?? natsAdapter(),
        routes: [],
        publishes: [TripEventHandlers],
    });
}

/**
 * Build ONE reactor bus: a single route subscribed to `trips.completed` (topic
 * from the route's proto option) under its OWN distinct consumer group.
 *
 * @param options.key - The reactor selector, fixing its consumer group.
 * @param options.route - The reactor's event route (its `OnTripCompleted` handler).
 * @param options.adapter - Adapter override (tests pass a shared `MemoryAdapter()`);
 *   defaults to a NATS adapter from `NATS_URL`.
 */
export function buildReactorBus(options: { readonly key: ReactorKey; readonly route: EventRoute; readonly adapter?: EventAdapter }): ManagedBus {
    return createEventBus({
        adapter: options.adapter ?? natsAdapter(),
        routes: [options.route],
        group: REACTOR_GROUP[options.key],
    });
}
