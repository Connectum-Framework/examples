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

describe("EventBus with AMQP/RabbitMQ — 2 Microservices + Saga", () => {
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
        const orders = await eventually(getOrders, (o) => statusOf(o, result.orderId) === "confirmed", `order ${result.orderId} to be confirmed`);
        assert.equal(statusOf(orders, result.orderId), "confirmed", "Order should be confirmed after saga");
        const reservation = reservationOf(await getReservations(), result.orderId);
        assert.ok(reservation);
        assert.equal(reservation.status, "reserved");
        assert.equal(reservation.product, "Widget");
    });

    it("cancel order → inventory released", async () => {
        const result = await connectPost(ORDER_URL, "orders.v1.OrderService/CreateOrder", {
            product: "Gadget", quantity: 2, customer: "Bob",
        }) as { orderId: string };
        await eventually(getReservations, (r) => reservationOf(r, result.orderId)?.status === "reserved", `the reservation for ${result.orderId}`);
        const cancelResult = await connectPost(ORDER_URL, "orders.v1.OrderService/CancelOrder", {
            orderId: result.orderId, reason: "Changed mind",
        }) as { orderId: string; status: string };
        assert.equal(cancelResult.status, "cancelled");
        const reservations = await eventually(getReservations, (r) => reservationOf(r, result.orderId)?.status === "released", `the reservation for ${result.orderId} to be released`);
        const reservation = reservationOf(reservations, result.orderId);
        assert.ok(reservation);
        assert.equal(reservation.status, "released");
    });

    it("multiple orders processed correctly", async () => {
        const orderIds: string[] = [];
        for (let i = 0; i < 3; i++) {
            const result = await connectPost(ORDER_URL, "orders.v1.OrderService/CreateOrder", {
                product: `Product-${i}`, quantity: i + 1, customer: `Customer-${i}`,
            }) as { orderId: string };
            orderIds.push(result.orderId);
        }
        const orders = await eventually(getOrders, (o) => orderIds.every((id) => statusOf(o, id) === "confirmed"), `orders ${orderIds.join(", ")} to be confirmed`);
        for (const orderId of orderIds) {
            assert.ok(orders.find((o) => o.orderId === orderId), `Should find order ${orderId}`);
            assert.equal(statusOf(orders, orderId), "confirmed");
        }
    });
});
