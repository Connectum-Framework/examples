/**
 * EventBus factory — one bus per process, with role-aware subscriptions.
 *
 * Every process gets a bus (TimeOffService always publishes LeaveApproved). The
 * PayrollService subscriber route is registered ONLY when payroll runs in this
 * process: in the split topology each process must subscribe to just its own
 * topics, or the broker's consumer-group delivery would steal LeaveApproved from
 * the payroll role.
 *
 * The adapter is pluggable: by default a NATS adapter (`NATS_URL`), but tests
 * pass a `MemoryAdapter` so the full publish → subscribe → balance-decrement flow
 * runs in-process with no broker.
 *
 * @module eventBus
 */

import { createEventBus } from "@connectum/events";
import type { EventAdapter, EventBus, EventRoute } from "@connectum/events";
import type { EventBusLike } from "@connectum/core";
import { NatsAdapter } from "@connectum/events-nats";
import { payrollEventRoutes } from "#services/payrollService.ts";
import { TYPE_NAMES } from "#topology.ts";

/** Options for {@link buildEventBus}. */
export interface BuildEventBusOptions {
    /** Proto `typeName`s mounted locally — decides which subscriber routes to register. */
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

    return createEventBus({
        adapter,
        routes,
        group: "hris-payroll",
        middleware: { retry: { maxRetries: 3, backoff: "exponential" } },
    });
}
