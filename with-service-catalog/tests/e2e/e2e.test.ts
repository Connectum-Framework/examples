/**
 * E2E tests for the service-catalog example.
 *
 * Verifies:
 *  - OrdersService.CreateOrder fans out to InventoryService via ctx.call
 *    (in-process, no socket).
 *  - The same flow works over an HTTP/2 client.
 *  - Out-of-stock surfaces as ConnectError(FailedPrecondition) from ctx.call.
 *  - The generated catalog drives both services.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { InventoryService } from "#gen/inventory/v1/inventory_pb.ts";
import { CreateOrderRequestSchema, OrdersService } from "#gen/orders/v1/orders_pb.ts";
import { buildServer } from "#server.ts";
import { resetStock } from "#services/inventoryService.ts";

describe("E2E: service catalog", () => {
    let server: Server;
    let httpOrders: ReturnType<typeof createClient<typeof OrdersService>>;

    before(async () => {
        server = buildServer(0);
        await server.start();
        const port = server.address?.port ?? 0;
        httpOrders = createClient(OrdersService, createGrpcTransport({ baseUrl: `http://localhost:${port}` }));
    });

    after(async () => {
        if (server.state === "running") await server.stop();
    });

    it("mounts both services from the generated catalog", () => {
        assert.equal(server.hasService(OrdersService), true);
        assert.equal(server.hasService(InventoryService), true);
    });

    it("in-process: CreateOrder composes InventoryService via ctx.call", async () => {
        resetStock();
        const orders = server.localClient(OrdersService);
        const res = await orders.createOrder(create(CreateOrderRequestSchema, { sku: "widget", quantity: 2, customerId: "c1" }));
        assert.equal(res.reserved, true);
        assert.equal(res.remainingStock, 8);
        assert.equal(res.orderId, "order-widget-c1");
    });

    it("out of stock: ctx.call short-circuits with FailedPrecondition", async () => {
        resetStock();
        const orders = server.localClient(OrdersService);
        await assert.rejects(
            orders.createOrder(create(CreateOrderRequestSchema, { sku: "gadget", quantity: 5, customerId: "c2" })),
            (err: unknown) => err instanceof ConnectError && err.code === Code.FailedPrecondition,
        );
    });

    it("HTTP/2 loopback: the same CreateOrder flow over the network", async () => {
        resetStock();
        const res = await httpOrders.createOrder(create(CreateOrderRequestSchema, { sku: "widget", quantity: 3, customerId: "c3" }));
        assert.equal(res.reserved, true);
        assert.equal(res.remainingStock, 7);
    });
});
