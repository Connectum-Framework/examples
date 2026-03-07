import { describe, it } from "node:test";
import assert from "node:assert/strict";

const ORDER_URL = process.env.ORDER_URL ?? "http://localhost:5001";
const INVENTORY_URL = process.env.INVENTORY_URL ?? "http://localhost:5002";

async function connectPost(baseUrl: string, method: string, body: Record<string, unknown> = {}): Promise<unknown> {
    const res = await fetch(`${baseUrl}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`${res.status} ${method}: ${text}`);
    }
    return res.json();
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

describe("EventBus with Valkey — 2 Microservices + Saga", () => {
    it("health check — order service", async () => {
        const res = await fetch(`${ORDER_URL}/healthz`);
        assert.equal(res.status, 200);
    });

    it("health check — inventory service", async () => {
        const res = await fetch(`${INVENTORY_URL}/healthz`);
        assert.equal(res.status, 200);
    });

    it("saga: CreateOrder → InventoryReserved → order confirmed", async () => {
        const result = await connectPost(ORDER_URL, "orders.v1.OrderService/CreateOrder", {
            product: "Widget", quantity: 5, customer: "Alice",
        }) as { orderId: string; status: string };
        assert.ok(result.orderId);
        assert.equal(result.status, "pending");
        await sleep(3000);
        const ordersResult = await connectPost(ORDER_URL, "orders.v1.OrderService/GetOrders", {}) as {
            orders: Array<{ orderId: string; status: string }>;
        };
        const order = ordersResult.orders.find((o) => o.orderId === result.orderId);
        assert.ok(order, `Should find order ${result.orderId}`);
        assert.equal(order!.status, "confirmed", "Order should be confirmed after saga");
        const inventory = await connectPost(INVENTORY_URL, "orders.v1.InventoryService/GetInventory", {}) as {
            reservations: Array<{ orderId: string; status: string; product: string }>;
        };
        const reservation = inventory.reservations.find((r) => r.orderId === result.orderId);
        assert.ok(reservation);
        assert.equal(reservation!.status, "reserved");
        assert.equal(reservation!.product, "Widget");
    });

    it("cancel order → inventory released", async () => {
        const result = await connectPost(ORDER_URL, "orders.v1.OrderService/CreateOrder", {
            product: "Gadget", quantity: 2, customer: "Bob",
        }) as { orderId: string };
        await sleep(3000);
        const cancelResult = await connectPost(ORDER_URL, "orders.v1.OrderService/CancelOrder", {
            orderId: result.orderId, reason: "Changed mind",
        }) as { orderId: string; status: string };
        assert.equal(cancelResult.status, "cancelled");
        await sleep(2000);
        const inventory = await connectPost(INVENTORY_URL, "orders.v1.InventoryService/GetInventory", {}) as {
            reservations: Array<{ orderId: string; status: string }>;
        };
        const reservation = inventory.reservations.find((r) => r.orderId === result.orderId);
        assert.ok(reservation);
        assert.equal(reservation!.status, "released");
    });

    it("multiple orders processed correctly", async () => {
        const orderIds: string[] = [];
        for (let i = 0; i < 3; i++) {
            const result = await connectPost(ORDER_URL, "orders.v1.OrderService/CreateOrder", {
                product: `Product-${i}`, quantity: i + 1, customer: `Customer-${i}`,
            }) as { orderId: string };
            orderIds.push(result.orderId);
        }
        await sleep(5000);
        const ordersResult = await connectPost(ORDER_URL, "orders.v1.OrderService/GetOrders", {}) as {
            orders: Array<{ orderId: string; status: string }>;
        };
        for (const orderId of orderIds) {
            const order = ordersResult.orders.find((o) => o.orderId === orderId);
            assert.ok(order, `Should find order ${orderId}`);
            assert.equal(order!.status, "confirmed");
        }
    });
});
