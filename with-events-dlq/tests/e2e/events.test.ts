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

type Order = { orderId: string; status: string; product: string; quantity: number; customer: string };
type Reservation = { orderId: string; status: string; product: string; quantity: number };
type DlqEvent = { originalTopic: string; originalEventId: string; error: string; attempt: string };

// JSON omits an empty repeated field, so an empty list arrives as an absent key.
const getDlqEvents = async (): Promise<DlqEvent[]> =>
    ((await connectPost(INVENTORY_URL, "orders.v1.InventoryService/GetDlqEvents", {})) as { events?: DlqEvent[] }).events ?? [];

// JSON omits an empty repeated field, so an empty list arrives as an absent key.
const getOrders = async (): Promise<Order[]> =>
    ((await connectPost(ORDER_URL, "orders.v1.OrderService/GetOrders", {})) as { orders?: Order[] }).orders ?? [];
const getReservations = async (): Promise<Reservation[]> =>
    ((await connectPost(INVENTORY_URL, "orders.v1.InventoryService/GetInventory", {})) as { reservations?: Reservation[] }).reservations ?? [];

const statusOf = (orders: Order[], orderId: string): string | undefined => orders.find((o) => o.orderId === orderId)?.status;
const reservationOf = (reservations: Reservation[], orderId: string): Reservation | undefined => reservations.find((r) => r.orderId === orderId);

describe("EventBus with NATS + DLQ — 2 Microservices + Saga", () => {
    // /healthz answers 200 with the overall status in the body only while the
    // service reports SERVING (any other status is a 503), so the body is what
    // tells a ready service from a started-but-not-ready one.
    for (const [name, url] of [["order", ORDER_URL], ["inventory", INVENTORY_URL]] as const) {
        it(`health check — ${name} service reports SERVING`, async () => {
            const res = await fetch(`${url}/healthz`);
            assert.equal(res.status, 200);
            const body = (await res.json()) as { status: string; service: string };
            assert.equal(body.status, "SERVING");
            assert.equal(body.service, "overall");
        });
    }

    it("saga: normal order → confirmed, reserved with its own product and quantity, and never dead-lettered", async () => {
        const result = await connectPost(ORDER_URL, "orders.v1.OrderService/CreateOrder", {
            product: "Widget", quantity: 5, customer: "Alice",
        }) as { orderId: string; status: string };
        assert.ok(result.orderId);
        assert.equal(result.status, "pending");
        const orders = await eventually(getOrders, (o) => statusOf(o, result.orderId) === "confirmed", `order ${result.orderId} to be confirmed`);
        const order = orders.find((o) => o.orderId === result.orderId);
        assert.equal(order?.status, "confirmed");
        assert.equal(order?.product, "Widget");
        assert.equal(order?.quantity, 5);
        assert.equal(order?.customer, "Alice");
        const reservation = reservationOf(await getReservations(), result.orderId);
        assert.equal(reservation?.status, "reserved");
        assert.equal(reservation?.product, "Widget");
        assert.equal(reservation?.quantity, 5);
        // A handler that succeeded must leave nothing in the dead-letter queue.
        assert.ok(!(await getDlqEvents()).some((e) => e.error.includes(result.orderId)), "a processed order must not be dead-lettered");
    });

    it("CancelOrder for an unknown order is the Connect not_found error (HTTP 404)", async () => {
        const res = await fetch(`${ORDER_URL}/orders.v1.OrderService/CancelOrder`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderId: "no-such-order", reason: "n/a" }),
        });
        assert.equal(res.status, 404);
        assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
        assert.equal(((await res.json()) as { code: string }).code, "not_found");
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
            getDlqEvents,
            // Match on this order's id: the DLQ store outlives a single run, so an
            // event from an earlier FAIL order must not satisfy this test.
            (events) => events.some((e) => e.error.includes(result.orderId)),
            `a dead-lettered event for order ${result.orderId}`,
        );
        const dlqEvent = dlqResult.find((e) => e.error.includes(result.orderId));
        assert.ok(dlqEvent, "Should find the DLQ event for this order");
        assert.equal(dlqEvent.originalTopic, "orders.v1.OrderCreated");
        assert.notEqual(dlqEvent.originalEventId, "", "the dead letter carries the id of the original event");
        // Exactly one dead letter for the order: retries happen before
        // dead-lettering and must not each produce an entry.
        assert.equal((await getDlqEvents()).filter((e) => e.error.includes(result.orderId)).length, 1);
        const orders = await getOrders();
        const order = orders.find((o) => o.orderId === result.orderId);
        assert.equal(order?.status, "pending", "FAIL order should remain pending");
        assert.equal(order?.product, "FAIL");
        // The failed handler never reserved stock for it.
        assert.equal(reservationOf(await getReservations(), result.orderId), undefined, "a dead-lettered order must not hold a reservation");
    });

    it("cancel order → inventory released", async () => {
        const result = await connectPost(ORDER_URL, "orders.v1.OrderService/CreateOrder", {
            product: "Gadget", quantity: 2, customer: "Charlie",
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
        assert.equal(reservation.product, "Gadget");
        assert.equal(reservation.quantity, 2);
    });
});
