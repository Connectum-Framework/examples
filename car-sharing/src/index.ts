/**
 * Entry point — starts this process in whatever role `SERVICES` selects.
 *
 * The SAME binary runs as a monolith (`SERVICES` unset) or as any single
 * microservice role (`SERVICES=fleet.v1.FleetService`, etc.). In Kubernetes each
 * Deployment sets `SERVICES` to its own typeName and `*_ADDR` to the in-cluster
 * DNS of its peers, so `ctx.call` auto-routes across pods (see k8s/).
 *
 * OpenTelemetry is initialized first (before the server) when an OTLP endpoint
 * is configured; it is a no-op otherwise.
 *
 * @module index
 */

import { healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { initObservability, otelServiceName, shutdownObservability } from "#observability.ts";
import { buildServer } from "#server.ts";
import { resolveTopology } from "#topology.ts";

initObservability();

const topology = resolveTopology();
const role = topology.isMonolith ? "monolith (all services)" : topology.localTypeNames.join(", ");
const server = buildServer();

server.on("start", () => console.log(`car-sharing [${otelServiceName()}] starting — role: ${role}`));
server.on("ready", () => {
    healthcheckManager.update(ServingStatus.SERVING);
    const addr = server.address;
    console.log(`car-sharing ready on ${addr?.address}:${addr?.port} — role: ${role}`);
    if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
        console.log(`OTel: exporting to ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
    }
});
server.on("stop", async () => {
    await shutdownObservability();
    console.log("car-sharing stopped");
});
server.on("error", (err: unknown) => {
    console.error("car-sharing error:", err);
    process.exitCode = 1;
});

await server.start();
