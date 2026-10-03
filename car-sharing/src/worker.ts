/**
 * Temporal worker — the durable saga's host process.
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
 * Every RPC the activities make is `internal`, so the worker is a service
 * identity of its own: it loads the `worker` key from `INTERNAL_SIGNING_KEY_FILE`
 * (or, with the variable unset, generates an ephemeral one), serves the public
 * key on its JWKS endpoint (`INTERNAL_JWKS_PORT`), and signs every
 * activity call with it. The JWKS endpoint is up BEFORE the worker polls, so
 * the first verifier that receives a worker token can fetch the key.
 *
 * @module worker
 */

import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { buildPublisherBus } from "#events/eventBus.ts";
import { createInternalSigner, InternalIdentity, internalJwksPort, signingKeyFileFromEnv, startJwksServer } from "#internalAuth.ts";
import * as activities from "#temporal/activities.ts";
import { createServiceClient } from "#temporal/clients.ts";
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_TASK_QUEUE } from "#temporal/config.ts";

async function main(): Promise<void> {
    const signer = await createInternalSigner(InternalIdentity.worker, { keyFile: signingKeyFileFromEnv() });
    const jwks = await startJwksServer({ signer, port: internalJwksPort(signer.identity) });
    // Inject the signed client before anything can schedule an activity.
    activities.setServiceClient(createServiceClient({ signer }));

    // Build + start the publish-only EventBus (Phase 3 broadcast) and inject it
    // into the activities module BEFORE the worker polls, so the terminal
    // `publishTripCompleted` activity publishes on a ready bus. The worker owns
    // its lifecycle: stopped in the `finally` below.
    const publisherBus = buildPublisherBus();
    let connection: NativeConnection | undefined;
    try {
        connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
        await publisherBus.start();
        activities.setPublisherBus(publisherBus);

        const worker = await Worker.create({
            connection,
            namespace: TEMPORAL_NAMESPACE,
            taskQueue: TEMPORAL_TASK_QUEUE,
            // Bundled (swc) at startup — no build step; ESM-safe path resolution.
            workflowsPath: fileURLToPath(new URL("./temporal/workflows.ts", import.meta.url)),
            activities,
        });

        console.log(
            `car-sharing temporal worker ready — taskQueue=${TEMPORAL_TASK_QUEUE} namespace=${TEMPORAL_NAMESPACE} temporal=${TEMPORAL_ADDRESS} internal JWKS on :${jwks.port}`,
        );
        await worker.run();
    } finally {
        // Settle all regardless of individual failures — a stop() rejection
        // must not leak the Temporal connection or keep the JWKS port open.
        await Promise.allSettled([publisherBus.stop(), connection?.close(), jwks.close()]);
    }
}

main().catch((err: unknown) => {
    console.error("car-sharing temporal worker error:", err);
    process.exitCode = 1;
});
