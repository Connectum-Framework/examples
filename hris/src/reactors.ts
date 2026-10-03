/**
 * Reactor entry — hosts `EmployeeOnboarded` broadcast subscribers.
 *
 * Which reactors run here is chosen by env, like `SERVICES` for the RPC roles:
 * `REACTORS` is a comma-separated list of `welcome`, `audit`, `headcount`;
 * unset or `*` hosts all three in this one process. Whatever the split, each
 * reactor gets its own bus and consumer group (`createBroadcastSubscribers`),
 * so every reactor receives every event whether they share a process or not —
 * the env only moves the process boundary.
 *
 * There is no inbound RPC and no HTTP server: a reactor only subscribes.
 * SIGINT/SIGTERM stop the buses cleanly.
 *
 * @module reactors
 */

import { buildReactorBuses } from "#broadcast/buses.ts";
import { ALL_REACTORS, isReactorKey } from "#broadcast/reactors.ts";
import type { ReactorKey } from "#broadcast/reactors.ts";

/** Parse `REACTORS`; unset or `*` selects every reactor, an unknown name is an error. */
function selectReactors(value: string | undefined): readonly ReactorKey[] {
    const names = (value ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
    if (names.length === 0 || names.includes("*")) return ALL_REACTORS;

    const unknown = names.filter((name) => !isReactorKey(name));
    if (unknown.length > 0) {
        throw new Error(`REACTORS must list reactors from ${ALL_REACTORS.join("|")} (unknown: ${unknown.join(", ")})`);
    }
    return names.filter(isReactorKey);
}

async function main(): Promise<void> {
    const reactors = selectReactors(process.env.REACTORS);
    const buses = buildReactorBuses({ reactors });

    await Promise.all(buses.map((bus) => bus.start()));
    console.log(`hris reactors ready — ${reactors.join(", ")} on onboarding.employee-onboarded via ${process.env.NATS_URL ?? "nats://localhost:4222"}`);

    const stop = async (): Promise<void> => {
        await Promise.allSettled(buses.map((bus) => bus.stop()));
        console.log("hris reactors stopped");
        process.exit(0);
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
}

main().catch((err: unknown) => {
    console.error("hris reactors error:", err);
    process.exitCode = 1;
});
