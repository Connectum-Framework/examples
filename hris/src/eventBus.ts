/**
 * EventBus factory — one bus per process, with role-aware subscriptions and
 * publications.
 *
 * Every process gets a bus, but what it registers depends on the role:
 *
 *  - The PayrollService subscriber route is registered ONLY when payroll runs in
 *    this process: in the split topology each process must subscribe to just its
 *    own topics, or the broker's consumer-group delivery would steal
 *    LeaveApproved from the payroll role.
 *  - `PayrollEventHandlers` is listed in `publishes` ONLY when TimeOffService
 *    runs in this process, because TimeOffService is the one that publishes
 *    LeaveApproved. Listing it fills the bus's publish-topic lookup from the
 *    proto `(connectum.events.v1.event).topic` option, so a split timeoff
 *    process — which has no payroll route — still publishes to
 *    `timeoff.leave-approved` instead of the message typeName.
 *  - `strictTopics: true` turns a publish whose topic the bus cannot resolve
 *    into an error at the call site. Without it, a role that publishes an event
 *    it never declared would silently emit to the typeName, where no subscriber
 *    listens, and the event would simply be lost.
 *
 * The adapter is pluggable: by default a NATS adapter (`NATS_URL`), but tests
 * pass a `MemoryAdapter` so the full publish → subscribe → balance-decrement flow
 * runs in-process with no broker.
 *
 * @module eventBus
 */

import type { DescService } from "@bufbuild/protobuf";
import type { EventBusLike } from "@connectum/core";
import { createEventBus } from "@connectum/events";
import type { EventAdapter, EventBus, EventRoute } from "@connectum/events";
import { NatsAdapter } from "@connectum/events-nats";
import { PayrollEventHandlers } from "#gen/payroll/v1/payroll_pb.ts";
import { payrollEventRoutes } from "#services/payrollService.ts";
import { TYPE_NAMES } from "#topology.ts";

/** Options for {@link buildEventBus}. */
export interface BuildEventBusOptions {
    /** Proto `typeName`s mounted locally — decides which routes and publications to register. */
    readonly localTypeNames: readonly string[];
    /** Adapter override (tests pass `MemoryAdapter()`); defaults to a NATS adapter. */
    readonly adapter?: EventAdapter;
}

/**
 * Build the EventBus for this process.
 *
 * @returns A bus implementing both the public `EventBus` API (for `publish`) and
 *   `EventBusLike` (so `createServer({ eventBus })` starts/stops it).
 */
export function buildEventBus(options: BuildEventBusOptions): EventBus & EventBusLike {
    const adapter = options.adapter ?? NatsAdapter({ servers: process.env.NATS_URL ?? "nats://localhost:4222", stream: "hris" });

    // Subscribe to LeaveApproved only when payroll is local to this process.
    const routes: EventRoute[] = [];
    if (options.localTypeNames.includes(TYPE_NAMES.payroll)) {
        routes.push(payrollEventRoutes);
    }

    // Declare the LeaveApproved topic only when its publisher is local.
    const publishes: DescService[] = [];
    if (options.localTypeNames.includes(TYPE_NAMES.timeoff)) {
        publishes.push(PayrollEventHandlers);
    }

    return createEventBus({
        adapter,
        routes,
        publishes,
        strictTopics: true,
        group: "hris-payroll",
        middleware: { retry: { maxRetries: 3, backoff: "exponential" } },
    });
}
