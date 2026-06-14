/**
 * Entry point — starts the server and places one demo order in-process.
 *
 * @module index
 */

import { create } from "@bufbuild/protobuf";
import { CreateOrderRequestSchema, OrdersService } from "#gen/orders/v1/orders_pb.ts";
import { buildServer } from "#server.ts";

const server = buildServer(Number(process.env.PORT ?? 5000));

server.on("ready", async () => {
    const addr = server.address;
    console.log(`with-service-catalog ready on ${addr?.address}:${addr?.port}`);

    // Place an order in-process; the handler fans out to InventoryService via ctx.call.
    const orders = server.localClient(OrdersService);
    const res = await orders.createOrder(create(CreateOrderRequestSchema, { sku: "widget", quantity: 2, customerId: "demo" }));
    console.log(`CreateOrder → ${res.orderId} | reserved=${res.reserved} | remainingStock=${res.remainingStock}`);
});

server.on("error", (err) => {
    console.error("Server error:", err);
    process.exitCode = 1;
});

await server.start();
