/**
 * EventBus factories for the EmployeeOnboarded broadcast — one publisher, N
 * independent reactors.
 *
 * `LeaveApproved` is the single-subscriber face of the EventBus (payroll). This
 * is the 1→N face: the fact "an employee was onboarded" is published once and
 * every reactor reacts to it on its own. The EventBus only announces; the
 * Temporal saga stays responsible for getting the onboarding done.
 *
 *  - The PUBLISHER bus is publish-only: no routes, `publishes:
 *    [OnboardingEventHandlers]`. That declaration is what tells a route-less bus
 *    the topic (`onboarding.employee-onboarded`, from the proto option);
 *    `strictTopics: true` makes any other, undeclared event fail at the publish
 *    call instead of leaking out under its typeName.
 *  - The REACTOR buses come from `createBroadcastSubscribers`: one bus per
 *    reactor, each under its own consumer group. Both properties are required
 *    for fan-out. One bus cannot hold two handlers for the same topic (the bus
 *    rejects it at `start()`), and on a broker a SHARED group load-balances —
 *    each event would go to only one reactor — whereas distinct groups give each
 *    reactor its own durable consumer, so each receives every event.
 *
 * The adapter is pluggable: NATS by default (`NATS_URL`), with a fresh adapter —
 * hence a separate connection and durable consumer — per reactor bus. Tests
 * pass ONE shared `MemoryAdapter()` to every bus so a single publish reaches all
 * reactors in-process. The memory adapter ignores groups; the distinct groups
 * still matter, because they are what makes the same wiring fan out on NATS.
 *
 * @module broadcast/buses
 */

import type { EventBusLike } from "@connectum/core";
import { createBroadcastSubscribers, createEventBus } from "@connectum/events";
import type { EventAdapter, EventBus } from "@connectum/events";
import { NatsAdapter } from "@connectum/events-nats";
import { REACTOR_GROUP, REACTOR_ROUTES } from "#broadcast/reactors.ts";
import type { ReactorKey } from "#broadcast/reactors.ts";
import { OnboardingEventHandlers } from "#gen/onboarding/v1/onboarding_events_pb.ts";

/** A bus that can both `publish` (the `EventBus` API) and start/stop (`EventBusLike`). */
export type ManagedBus = EventBus & EventBusLike;

/** The NATS adapter every broadcast bus uses outside tests (same stream as LeaveApproved). */
function natsAdapter(): EventAdapter {
    return NatsAdapter({ servers: process.env.NATS_URL ?? "nats://localhost:4222", stream: "hris" });
}

/**
 * Build the publish-only bus the Temporal worker announces `EmployeeOnboarded`
 * on. The bus is returned unstarted; the caller owns `start()` / `stop()`.
 *
 * @param options.adapter - Adapter override (tests pass a shared `MemoryAdapter()`);
 *   defaults to a NATS adapter from `NATS_URL`.
 */
export function buildOnboardedPublisherBus(options: { readonly adapter?: EventAdapter } = {}): ManagedBus {
    return createEventBus({
        adapter: options.adapter ?? natsAdapter(),
        publishes: [OnboardingEventHandlers],
        strictTopics: true,
    });
}

/**
 * Build one bus per selected reactor, each under its own consumer group. The
 * buses are returned unstarted; the caller owns `start()` / `stop()`.
 *
 * @param options.reactors - Which reactors this process hosts.
 * @param options.adapter - ONE adapter shared by every bus (tests pass a
 *   `MemoryAdapter()`); defaults to a fresh NATS adapter per bus.
 */
export function buildReactorBuses(options: { readonly reactors: readonly ReactorKey[]; readonly adapter?: EventAdapter }): ManagedBus[] {
    return createBroadcastSubscribers({
        adapter: options.adapter ?? natsAdapter,
        reactors: options.reactors.map((key) => ({ group: REACTOR_GROUP[key], routes: [REACTOR_ROUTES[key]] })),
    });
}
