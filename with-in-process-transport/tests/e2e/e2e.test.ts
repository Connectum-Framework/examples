/**
 * E2E tests for the in-process-transport example.
 *
 * Verifies:
 *  - OrdersService.CreateOrder works via local transport (no socket).
 *  - The same Server simultaneously serves HTTP/2 clients.
 *  - server.hasService() reflects the registry.
 *  - InventoryService composition produces consistent state across transports.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { InventoryService } from "#gen/inventory/v1/inventory_pb.ts";
import { OrdersService } from "#gen/orders/v1/orders_pb.ts";
import { buildServer } from "#server.ts";
import { resetStock } from "#services/inventoryService.ts";

describe("E2E: in-process transport", () => {
    let server: Server;
    let port: number;
    let httpOrders: ReturnType<typeof createClient<typeof OrdersService>>;

    before(async () => {
        server = buildServer(0);
        await server.start();
        port = server.address?.port ?? 0;
        const transport = createGrpcTransport({
            baseUrl: `http://localhost:${port}`,
        });
        httpOrders = createClient(OrdersService, transport);
    });

    after(async () => {
        if (server.state === "running") {
            await server.stop();
        }
    });

    it("hasService() returns true for both registered services", () => {
        assert.equal(server.hasService(OrdersService), true);
        assert.equal(server.hasService(InventoryService), true);
    });

    it("in-process: OrdersService.CreateOrder composes InventoryService.Reserve", async () => {
        resetStock();
        const orders = server.localClient(OrdersService);
        const resp = await orders.createOrder({
            sku: "SKU-1",
            quantity: 10,
            customerId: "c1",
        });
        assert.equal(resp.reserved, true);
        assert.equal(resp.remainingStock, 90);
        assert.match(resp.orderId, /^ord_/);
    });

    it("in-process: insufficient stock → reserved=false, no orderId", async () => {
        resetStock();
        const orders = server.localClient(OrdersService);
        const resp = await orders.createOrder({
            sku: "SKU-2",
            quantity: 999,
            customerId: "c2",
        });
        assert.equal(resp.reserved, false);
        assert.equal(resp.orderId, "");
    });

    it("HTTP/2 loopback: same OrdersService.CreateOrder over network", async () => {
        resetStock();
        const resp = await httpOrders.createOrder({
            sku: "SKU-1",
            quantity: 7,
            customerId: "c3",
        });
        assert.equal(resp.reserved, true);
        assert.equal(resp.remainingStock, 93);
    });

    it("server.client(InventoryService) returns a working local client", async () => {
        resetStock();
        const inv = server.client(InventoryService);
        const stock = await inv.checkStock({ sku: "SKU-1" });
        assert.equal(stock.sku, "SKU-1");
        assert.equal(stock.available, 100);
    });

    it("polyglot: in-process and HTTP transports observe consistent state", async () => {
        resetStock();
        const localOrders = server.localClient(OrdersService);

        const r1 = await localOrders.createOrder({
            sku: "SKU-1",
            quantity: 10,
            customerId: "loc",
        });
        const r2 = await httpOrders.createOrder({
            sku: "SKU-1",
            quantity: 5,
            customerId: "http",
        });

        assert.equal(r1.reserved, true);
        assert.equal(r2.reserved, true);
        assert.equal(r1.remainingStock, 90);
        assert.equal(r2.remainingStock, 85);
    });
});
