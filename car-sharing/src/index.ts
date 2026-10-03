/**
 * Entry point — starts this process in whatever role `SERVICES` selects.
 *
 * The SAME binary runs as a monolith (`SERVICES` unset) or as any single
 * microservice role (`SERVICES=fleet.v1.FleetService`, etc.). In Kubernetes each
 * Deployment sets `SERVICES` to its own typeName and `*_ADDR` to the in-cluster
 * DNS of its peers, so `ctx.call` auto-routes across pods (see k8s/).
 *
 * A role hosting TripService signs its internal calls as `trips`: it loads the
 * trips key from `INTERNAL_SIGNING_KEY_FILE` (or, with the variable unset,
 * generates an ephemeral one) and publishes the public key on its JWKS endpoint
 * (`INTERNAL_JWKS_PORT`) BEFORE the server accepts requests, so the first
 * verifier that sees a trips token can already fetch the key. fleet and billing
 * call no other service, so they hold no key and serve no JWKS.
 *
 * OpenTelemetry is initialized first (before the server) when an OTLP endpoint
 * is configured; it is a no-op otherwise.
 *
 * @module index
 */

import { healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { createInternalSigner, InternalIdentity, internalJwksPort, signingKeyFileFromEnv, startJwksServer } from "#internalAuth.ts";
import { initObservability, otelServiceName, shutdownObservability } from "#observability.ts";
import { buildServer } from "#server.ts";
import { resolveTopology, TYPE_NAMES } from "#topology.ts";

initObservability();

const topology = resolveTopology();
const role = topology.isMonolith ? "monolith (all services)" : topology.localTypeNames.join(", ");

const internalSigner = topology.localTypeNames.includes(TYPE_NAMES.trips)
    ? await createInternalSigner(InternalIdentity.trips, { keyFile: signingKeyFileFromEnv() })
    : undefined;
const jwks = internalSigner ? await startJwksServer({ signer: internalSigner, port: internalJwksPort(internalSigner.identity) }) : undefined;

const server = buildServer({ topology, internalSigner });

server.on("start", () => console.log(`car-sharing [${otelServiceName()}] starting — role: ${role}`));
server.on("ready", () => {
    healthcheckManager.update(ServingStatus.SERVING);
    const addr = server.address;
    console.log(`car-sharing ready on ${addr?.address}:${addr?.port} — role: ${role}`);
    if (jwks) {
        console.log(`internal JWKS (signing as "${internalSigner?.identity}") on :${jwks.port}`);
    }
    if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
        console.log(`OTel: exporting to ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
    }
});
server.on("stop", async () => {
    // Settle both: a failing exporter flush must not keep the JWKS port open.
    await Promise.allSettled([shutdownObservability(), jwks?.close()]);
    console.log("car-sharing stopped");
});
server.on("error", (err: unknown) => {
    console.error("car-sharing error:", err);
    process.exitCode = 1;
});

await server.start();
