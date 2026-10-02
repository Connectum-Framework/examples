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

/**
 * Poll `read` until `done` holds. The saga runs through the broker
 * asynchronously, so a fixed pause is either too short on a slow machine (a
 * false failure) or longer than needed. The deadline is generous; when it
 * passes, the error shows the last value read.
 */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last = await read();
    while (!done(last)) {
        if (Date.now() > deadline) {
            throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}; last value: ${JSON.stringify(last)}`);
        }
        await sleep(200);
        last = await read();
    }
    return last;
}

type Order = { orderId: string; status: string };
type Reservation = { orderId: string; status: string; product: string };

// JSON omits an empty repeated field, so an empty list arrives as an absent key.
const getOrders = async (): Promise<Order[]> =>
    ((await connectPost(ORDER_URL, "orders.v1.OrderService/GetOrders", {})) as { orders?: Order[] }).orders ?? [];
const getReservations = async (): Promise<Reservation[]> =>
    ((await connectPost(INVENTORY_URL, "orders.v1.InventoryService/GetInventory", {})) as { reservations?: Reservation[] }).reservations ?? [];

const statusOf = (orders: Order[], orderId: string): string | undefined => orders.find((o) => o.orderId === orderId)?.status;
const reservationOf = (reservations: Reservation[], orderId: string): Reservation | undefined => reservations.find((r) => r.orderId === orderId);

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
        const orders = await eventually(getOrders, (o) => statusOf(o, result.orderId) === "confirmed", `order ${result.orderId} to be confirmed`);
        assert.ok(orders.find((o) => o.orderId === result.orderId));
        assert.equal(statusOf(orders, result.orderId), "confirmed");
    });

    it("DLQ: FAIL product → retry 2x → dead-letter-queue", async () => {
        const result = await connectPost(ORDER_URL, "orders.v1.OrderService/CreateOrder", {
            product: "FAIL", quantity: 1, customer: "Bob",
        }) as { orderId: string; status: string };
        assert.ok(result.orderId);
        assert.equal(result.status, "pending");
        // The handler fails on FAIL, is retried, and the event then lands in the
        // dead-letter queue; wait for it there rather than for a fixed time.
        // JSON omits an empty repeated field, so `events` is absent until the
        // first event is dead-lettered.
        const dlqResult = await eventually(
            async () => {
                const reply = (await connectPost(INVENTORY_URL, "orders.v1.InventoryService/GetDlqEvents", {})) as {
                    events?: Array<{ originalTopic: string; error: string; attempt: string }>;
                };
                return { events: reply.events ?? [] };
            },
            // Match on this order's id: the DLQ store outlives a single run, so an
            // event from an earlier FAIL order must not satisfy this test.
            (dlq) => dlq.events.some((e) => e.error.includes(result.orderId)),
            `a dead-lettered event for order ${result.orderId}`,
        );
        const dlqEvent = dlqResult.events.find((e) => e.error.includes(result.orderId));
        assert.ok(dlqEvent, "Should find the DLQ event for this order");
        assert.equal(dlqEvent.originalTopic, "orders.v1.OrderCreated");
        const orders = await getOrders();
        assert.ok(orders.find((o) => o.orderId === result.orderId));
        assert.equal(statusOf(orders, result.orderId), "pending", "FAIL order should remain pending");
    });

    it("cancel order → inventory released", async () => {
        const result = await connectPost(ORDER_URL, "orders.v1.OrderService/CreateOrder", {
            product: "Gadget", quantity: 2, customer: "Charlie",
        }) as { orderId: string };
        await eventually(getReservations, (r) => reservationOf(r, result.orderId)?.status === "reserved", `the reservation for ${result.orderId}`);
        await connectPost(ORDER_URL, "orders.v1.OrderService/CancelOrder", {
            orderId: result.orderId, reason: "Changed mind",
        });
        const reservations = await eventually(getReservations, (r) => reservationOf(r, result.orderId)?.status === "released", `the reservation for ${result.orderId} to be released`);
        const reservation = reservationOf(reservations, result.orderId);
        assert.ok(reservation);
        assert.equal(reservation.status, "released");
    });
});
