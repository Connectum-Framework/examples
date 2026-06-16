/**
 * Entry point — starts this process in whatever role `SERVICES` selects.
 *
 * The SAME binary runs as a monolith (`SERVICES` unset) or as any single
 * microservice role (`SERVICES=directory.v1.DirectoryService`, etc.). The bus
 * connects to NATS (`NATS_URL`); the payroll role subscribes to LeaveApproved.
 *
 * @module index
 */

import { healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { buildServer } from "#server.ts";
import { resolveTopology } from "#topology.ts";

const topology = resolveTopology();
const role = topology.isMonolith ? "monolith (all services)" : topology.localTypeNames.join(", ");
const server = buildServer();

server.on("start", () => console.log(`HRIS starting — role: ${role}`));
server.on("ready", () => {
    healthcheckManager.update(ServingStatus.SERVING);
    const addr = server.address;
    console.log(`HRIS ready on ${addr?.address}:${addr?.port} — role: ${role}`);
    console.log(`EventBus: ${process.env.NATS_URL ?? "nats://localhost:4222"}`);
});
server.on("stop", () => console.log("HRIS stopped"));
server.on("error", (err: unknown) => {
    console.error("HRIS error:", err);
    process.exitCode = 1;
});

await server.start();
