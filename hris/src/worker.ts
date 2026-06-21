/**
 * Temporal worker — the onboarding saga's host process.
 *
 * This is a NEW process type alongside the RPC roles. It is the ONLY entry that
 * imports `@temporalio/worker` (the Rust core-bridge native addon + the
 * webpack/swc workflow bundler), so the existing `node src/index.ts` roles keep
 * their no-build, native-TS run model untouched. The worker runs its own
 * process (`node src/worker.ts`), not a `SERVICES`-selected role — it has no
 * inbound RPC; it polls Temporal for workflow/activity tasks.
 *
 * `Worker.create({ workflowsPath })` bundles `temporal/workflows.ts` on the fly
 * (swc) at startup — no separate build step. Under ESM, `workflowsPath` is
 * resolved with `fileURLToPath(new URL(...))`. The activities run here in full
 * Node and drive the role services over ConnectRPC (`temporal/clients.ts`).
 *
 * @module worker
 */

import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { buildPublisherBus } from "#events/broadcastBus.ts";
import * as activities from "#temporal/activities.ts";
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_TASK_QUEUE } from "#temporal/config.ts";

async function main(): Promise<void> {
    const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
    // Build + start the publish-only EventBus (Phase 5b broadcast) and inject it
    // into the activities module BEFORE the worker polls, so the terminal
    // `announceOnboarded` activity publishes on a ready bus. The worker owns its
    // lifecycle: stopped in the `finally` below.
    const publisherBus = buildPublisherBus();
    await publisherBus.start();
    activities.setPublisherBus(publisherBus);
    try {
        const worker = await Worker.create({
            connection,
            namespace: TEMPORAL_NAMESPACE,
            taskQueue: TEMPORAL_TASK_QUEUE,
            // Bundled (swc) at startup — no build step; ESM-safe path resolution.
            workflowsPath: fileURLToPath(new URL("./temporal/workflows.ts", import.meta.url)),
            activities,
        });

        console.log(`hris temporal worker ready — taskQueue=${TEMPORAL_TASK_QUEUE} namespace=${TEMPORAL_NAMESPACE} temporal=${TEMPORAL_ADDRESS}`);
        await worker.run();
    } finally {
        await publisherBus.stop();
        await connection.close();
    }
}

main().catch((err: unknown) => {
    console.error("hris temporal worker error:", err);
    process.exitCode = 1;
});
