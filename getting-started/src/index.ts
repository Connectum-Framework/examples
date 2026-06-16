/**
 * Connectum quickstart — start the server.
 *
 * Runs the same on Node.js, Bun and tsx (see the README). The interesting part
 * is how little wiring it takes: health, reflection, default interceptors and
 * graceful shutdown all come from one `createServer` call (see `server.ts`).
 *
 * @module index
 */

import { healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { buildServer } from "#server.ts";

const server = buildServer(Number(process.env.PORT ?? 5000), true);

server.on("ready", () => {
    const addr = server.address;
    healthcheckManager.update(ServingStatus.SERVING);
    console.log(`getting-started ready on ${addr?.address}:${addr?.port}`);
    console.log("  services: greeter.v1.GreeterService, grpc.health.v1.Health, grpc.reflection.v1.ServerReflection");
    console.log(`\n  grpcurl -plaintext -d '{"name":"world"}' localhost:${addr?.port} greeter.v1.GreeterService/SayHello`);
});

server.on("stop", () => console.log("stopped"));
server.on("error", (err) => {
    console.error("server error:", err);
    process.exitCode = 1;
});

await server.start();
