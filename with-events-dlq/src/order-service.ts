import { createServer } from "@connectum/core";
import { Healthcheck, healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { Reflection } from "@connectum/reflection";
import { orderEventBus } from "./orderEventBus.ts";
import { orderServiceRoutes } from "./services/orderService.ts";

const PORT = Number(process.env.PORT ?? 5001);

console.log("Starting Order Service (Events + NATS + DLQ)...\n");

const server = createServer({
    services: [orderServiceRoutes],
    eventBus: orderEventBus,
    port: PORT,
    host: "0.0.0.0",
    protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
    interceptors: createDefaultInterceptors(),
    shutdown: { autoShutdown: true, timeout: 10_000 },
});

server.on("start", () => console.log("Order Service starting..."));
server.on("ready", () => {
    healthcheckManager.update(ServingStatus.SERVING);
    const addr = server.address;
    console.log(`\nOrder Service ready on ${addr?.address}:${addr?.port}`);
    console.log(`NATS: ${process.env.NATS_URL ?? "nats://localhost:4222"}`);
    console.log(`DLQ Topic: dead-letter-queue`);
    console.log(`Retry: 2 attempts, fixed 200ms backoff`);
    console.log(`\nTest with curl:`);
    console.log(`  # Normal order (will succeed):`);
    console.log(`  curl -X POST http://localhost:${addr?.port}/orders.v1.OrderService/CreateOrder \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"product":"Widget","quantity":5,"customer":"Alice"}'`);
    console.log(`\n  # Failing order (will go to DLQ):`);
    console.log(`  curl -X POST http://localhost:${addr?.port}/orders.v1.OrderService/CreateOrder \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"product":"FAIL","quantity":1,"customer":"Bob"}'`);
    console.log("\nPress Ctrl+C to shutdown gracefully\n");
});
server.on("stop", () => console.log("Order Service stopped"));
server.on("error", (err: unknown) => console.error("Order Service error:", err));

await server.start();
