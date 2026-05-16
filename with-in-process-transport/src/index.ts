/**
 * In-Process Transport Example — entry point
 *
 * Demonstrates two services (OrdersService, InventoryService) deployed
 * inside a single Connectum server. OrdersService.CreateOrder composes
 * InventoryService.Reserve via the **in-process transport** — no HTTP/2
 * loopback, no serialization across a network socket.
 *
 * The same server also exposes both services over HTTP/2, so external
 * clients can call them as usual.
 */

import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { InventoryService } from "#gen/inventory/v1/inventory_pb.ts";
import { OrdersService } from "#gen/orders/v1/orders_pb.ts";
import { buildServer } from "#server.ts";

console.log("Starting In-Process Transport Example...\n");

const server = buildServer(5000);

server.on("ready", async () => {
    const addr = server.address;
    console.log(`Server ready on ${addr?.address}:${addr?.port}\n`);

    // ------------------------------------------------------------------
    // Demo 1 — in-process invocation via server.localClient(...)
    // ------------------------------------------------------------------
    console.log("[demo] In-process: server.localClient(OrdersService).createOrder(...)");
    const localOrders = server.localClient(OrdersService);
    const localResp = await localOrders.createOrder({
        sku: "SKU-1",
        quantity: 3,
        customerId: "cust-local",
    });
    console.log("  →", localResp);

    // ------------------------------------------------------------------
    // Demo 2 — same call over HTTP/2 loopback
    // ------------------------------------------------------------------
    console.log("\n[demo] HTTP/2 loopback: gRPC client → http://localhost");
    const httpTransport = createGrpcTransport({
        baseUrl: `http://localhost:${addr?.port}`,
    });
    const httpOrders = createClient(OrdersService, httpTransport);
    const httpResp = await httpOrders.createOrder({
        sku: "SKU-2",
        quantity: 5,
        customerId: "cust-http",
    });
    console.log("  →", httpResp);

    // ------------------------------------------------------------------
    // Demo 3 — direct InventoryService call (local)
    // ------------------------------------------------------------------
    console.log("\n[demo] In-process: server.client(InventoryService).checkStock(...)");
    const inventory = server.client(InventoryService);
    const stock = await inventory.checkStock({ sku: "SKU-1" });
    console.log("  →", stock);

    console.log("\nPress Ctrl+C to shutdown.\n");
});

server.on("error", (err) => {
    console.error("Server error:", err);
});

server.on("stop", () => {
    console.log("Server stopped.");
});

await server.start();
