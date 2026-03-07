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

describe("EventBus with NATS + DLQ — 2 Microservices + Saga", () => {
    it("health check — order service", async () => {
        const res = await fetch(`${ORDER_URL}/healthz`);
        assert.equal(res.status, 200);
    });

    it("health check — inventory service", async () => {
        const res = await fetch(`${INVENTORY_URL}/healthz`);
        assert.equal(res.status, 200);
    });

    it("saga: normal order → confirmed", async () => {
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
        assert.ok(order);
        assert.equal(order!.status, "confirmed");
    });

    it("DLQ: FAIL product → retry 2x → dead-letter-queue", async () => {
        const result = await connectPost(ORDER_URL, "orders.v1.OrderService/CreateOrder", {
            product: "FAIL", quantity: 1, customer: "Bob",
        }) as { orderId: string; status: string };
        assert.ok(result.orderId);
        assert.equal(result.status, "pending");
        await sleep(5000);
        const ordersResult = await connectPost(ORDER_URL, "orders.v1.OrderService/GetOrders", {}) as {
            orders: Array<{ orderId: string; status: string }>;
        };
        const order = ordersResult.orders.find((o) => o.orderId === result.orderId);
        assert.ok(order);
        assert.equal(order!.status, "pending", "FAIL order should remain pending");
        const dlqResult = await connectPost(INVENTORY_URL, "orders.v1.InventoryService/GetDlqEvents", {}) as {
            events: Array<{ originalTopic: string; error: string; attempt: string }>;
        };
        assert.ok(dlqResult.events.length > 0, "Should have DLQ events");
        const dlqEvent = dlqResult.events.find((e) => e.error.includes("FAIL"));
        assert.ok(dlqEvent, "Should find DLQ event with FAIL error");
    });

    it("cancel order → inventory released", async () => {
        const result = await connectPost(ORDER_URL, "orders.v1.OrderService/CreateOrder", {
            product: "Gadget", quantity: 2, customer: "Charlie",
        }) as { orderId: string };
        await sleep(3000);
        await connectPost(ORDER_URL, "orders.v1.OrderService/CancelOrder", {
            orderId: result.orderId, reason: "Changed mind",
        });
        await sleep(2000);
        const inventory = await connectPost(INVENTORY_URL, "orders.v1.InventoryService/GetInventory", {}) as {
            reservations: Array<{ orderId: string; status: string }>;
        };
        const reservation = inventory.reservations.find((r) => r.orderId === result.orderId);
        assert.ok(reservation);
        assert.equal(reservation!.status, "released");
    });
});
