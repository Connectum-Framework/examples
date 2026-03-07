import { createServer } from "@connectum/core";
import { Healthcheck, healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { Reflection } from "@connectum/reflection";
import { inventoryEventBus, inventoryAdapter } from "./inventoryEventBus.ts";
import { inventoryServiceRoutes } from "./services/inventoryService.ts";
import { dlqEvents } from "./services/inventoryEvents.ts";

const PORT = Number(process.env.PORT ?? 5002);

console.log("Starting Inventory Service (Events + NATS + DLQ)...\n");

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
    console.log(`DLQ Topic: dead-letter-queue`);
    console.log(`DLQ Monitor: watching "dead-letter-queue" topic`);
    console.log(`\n  curl -X POST http://localhost:${addr?.port}/orders.v1.InventoryService/GetDlqEvents \\`);
    console.log(`    -H "Content-Type: application/json" -d '{}'`);
    console.log("\nPress Ctrl+C to shutdown gracefully\n");

    // Set up DLQ monitor
    inventoryAdapter.subscribe(
        ["dead-letter-queue"],
        async (rawEvent) => {
            console.log(`[DLQ Monitor] Received DLQ event: ${rawEvent.eventType}`);
            dlqEvents.push({
                originalTopic: rawEvent.metadata.get("dlq.original-topic") ?? "unknown",
                originalEventId: rawEvent.metadata.get("dlq.original-id") ?? "unknown",
                error: rawEvent.metadata.get("dlq.error") ?? "unknown",
                attempt: rawEvent.metadata.get("dlq.attempt") ?? "0",
            });
            console.log(`[DLQ Monitor] DLQ event recorded, total: ${dlqEvents.length}`);
        },
        { group: "dlq-monitor" },
    ).catch((err) => {
        console.error("[DLQ Monitor] Failed to subscribe:", err);
    });
});
server.on("stop", () => console.log("Inventory Service stopped"));
server.on("error", (err: unknown) => console.error("Inventory Service error:", err));

await server.start();
