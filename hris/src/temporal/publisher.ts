/**
 * The worker's handle on the `EmployeeOnboarded` publisher bus.
 *
 * The worker builds and starts the bus before it polls Temporal, hands it over
 * here, and stops it on shutdown; the announce activity only reads it. This
 * lives in its own module rather than in `activities.ts` on purpose:
 * `Worker.create({ activities })` registers EVERY function exported from the
 * activities module as an activity, so a setter exported there would become a
 * callable activity too.
 *
 * @module temporal/publisher
 */

import type { ManagedBus } from "#broadcast/buses.ts";

let publisherBus: ManagedBus | undefined;

/**
 * Hand the started publisher bus to the activities (the worker does this at
 * startup; tests pass a `MemoryAdapter`-backed bus). Pass `undefined` to clear.
 *
 * @param bus - A started publish-only bus, or `undefined`.
 */
export function setOnboardedPublisher(bus: ManagedBus | undefined): void {
    publisherBus = bus;
}

/**
 * The bus to announce on. Throws when none was set: that is a wiring mistake in
 * the hosting process, and failing the activity makes it visible in Temporal
 * instead of silently dropping the broadcast.
 */
export function onboardedPublisher(): ManagedBus {
    if (publisherBus === undefined) {
        throw new Error("EmployeeOnboarded publisher bus is not set: the worker must call setOnboardedPublisher() with a started bus before running activities.");
    }
    return publisherBus;
}
