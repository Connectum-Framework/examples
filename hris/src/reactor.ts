/**
 * Reactor entry — a long-lived `EmployeeOnboarded` broadcast subscriber.
 *
 * One image, role by env: `REACTOR=welcome|audit|headcount` selects WHICH
 * reactor route this process mounts and WHICH consumer group it joins. Each
 * reactor runs as its OWN process with its OWN EventBus + DISTINCT group, so on
 * NATS each gets its own durable consumer → every process receives every
 * `onboarding.employee-onboarded` event = fan-out (a shared group would
 * load-balance / steal instead).
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
import { buildReactorBus } from "#events/broadcastBus.ts";
import type { ManagedBus, ReactorKey } from "#events/broadcastBus.ts";
import { auditReactorRoutes, headcountReactorRoutes, welcomeReactorRoutes } from "#events/reactors.ts";

/** Map each reactor selector to its route. The group is fixed by the key in `buildReactorBus`. */
const REACTOR_ROUTES: Readonly<Record<ReactorKey, EventRoute>> = {
    welcome: welcomeReactorRoutes,
    audit: auditReactorRoutes,
    headcount: headcountReactorRoutes,
};

/** Read + validate the `REACTOR` selector from env. */
function selectReactor(): ReactorKey {
    const key = process.env.REACTOR;
    if (key === "welcome" || key === "audit" || key === "headcount") {
        return key;
    }
    throw new Error(`REACTOR must be one of welcome|audit|headcount (got ${key === undefined ? "<unset>" : `"${key}"`})`);
}

async function main(): Promise<void> {
    const key = selectReactor();
    const bus: ManagedBus = buildReactorBus({ key, route: REACTOR_ROUTES[key] });

    await bus.start();
    console.log(`hris reactor ready — REACTOR=${key} topic=onboarding.employee-onboarded nats=${process.env.NATS_URL ?? "nats://localhost:4222"}`);

    const stop = async (): Promise<void> => {
        await bus.stop();
        console.log(`hris reactor stopped — REACTOR=${key}`);
        process.exit(0);
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
}

main().catch((err: unknown) => {
    console.error("hris reactor error:", err);
    process.exitCode = 1;
});
