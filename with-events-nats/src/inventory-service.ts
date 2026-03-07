import { createServer } from "@connectum/core";
import { Healthcheck, healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { Reflection } from "@connectum/reflection";
import { inventoryEventBus } from "./inventoryEventBus.ts";
import { inventoryServiceRoutes } from "./services/inventoryService.ts";

const PORT = Number(process.env.PORT ?? 5002);

console.log("Starting Inventory Service (Events + NATS)...\n");

const server = createServer({
    services: [inventoryServiceRoutes],
    eventBus: inventoryEventBus,
    port: PORT,
    host: "0.0.0.0",
    protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
    interceptors: createDefaultInterceptors(),
    shutdown: { autoShutdown: true, timeout: 10_000 },
});

server.on("start", () => console.log("Inventory Service starting..."));
server.on("ready", () => {
    healthcheckManager.update(ServingStatus.SERVING);
    const addr = server.address;
    console.log(`\nInventory Service ready on ${addr?.address}:${addr?.port}`);
    console.log(`NATS: ${process.env.NATS_URL ?? "nats://localhost:4222"}`);
    console.log(`\n  curl -X POST http://localhost:${addr?.port}/orders.v1.InventoryService/GetInventory \\`);
    console.log(`    -H "Content-Type: application/json" -d '{}'`);
    console.log("\nPress Ctrl+C to shutdown gracefully\n");
});
server.on("stop", () => console.log("Inventory Service stopped"));
server.on("error", (err: unknown) => console.error("Inventory Service error:", err));

await server.start();
