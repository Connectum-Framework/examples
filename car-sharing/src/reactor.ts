/**
 * Reactor entry — a long-lived `TripCompleted` broadcast subscriber.
 *
 * One image, role by env: `REACTOR=pricing|audit|notify` selects WHICH reactor
 * route this process mounts and WHICH consumer group it joins. Each reactor runs
 * as its OWN process with its OWN EventBus + DISTINCT group, so on NATS each gets
 * its own durable consumer → every process receives every `trips.completed`
 * event = fan-out (a shared group would load-balance / steal instead).
 *
 * This mirrors `index.ts` (role by `SERVICES`) and `worker.ts` (the saga host):
 * the same binary, a different process boundary chosen by env. Co-hosting all
 * three reactor buses in one process would change the process count but NOT the
 * fan-out semantics (still three durable consumers).
 *
 * The bus is NATS-backed (`NATS_URL`); there is no inbound RPC and no HTTP
 * server — a reactor only subscribes. SIGINT/SIGTERM stop the bus cleanly.
 *
 * @module reactor
 */

import type { EventRoute } from "@connectum/events";
import { buildReactorBus } from "#events/eventBus.ts";
import type { ManagedBus, ReactorKey } from "#events/eventBus.ts";
import { auditReactorRoutes, notifyReactorRoutes, pricingReactorRoutes } from "#events/reactors.ts";

/** Map each reactor selector to its route. The group is fixed by the key in `buildReactorBus`. */
const REACTOR_ROUTES: Readonly<Record<ReactorKey, EventRoute>> = {
    pricing: pricingReactorRoutes,
    audit: auditReactorRoutes,
    notify: notifyReactorRoutes,
};

/** Read + validate the `REACTOR` selector from env. */
function selectReactor(): ReactorKey {
    const key = process.env.REACTOR;
    if (key === "pricing" || key === "audit" || key === "notify") {
        return key;
    }
    throw new Error(`REACTOR must be one of pricing|audit|notify (got ${key === undefined ? "<unset>" : `"${key}"`})`);
}

async function main(): Promise<void> {
    const key = selectReactor();
    const bus: ManagedBus = buildReactorBus({ key, route: REACTOR_ROUTES[key] });

    await bus.start();
    console.log(`car-sharing reactor ready — REACTOR=${key} topic=trips.completed nats=${process.env.NATS_URL ?? "nats://localhost:4222"}`);

    const stop = async (): Promise<void> => {
        try {
            await bus.stop();
            console.log(`car-sharing reactor stopped — REACTOR=${key}`);
            process.exit(0);
        } catch (err) {
            console.error(`car-sharing reactor shutdown error — REACTOR=${key}:`, err);
            process.exit(1);
        }
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
}

main().catch((err: unknown) => {
    console.error("car-sharing reactor error:", err);
    process.exitCode = 1;
});
