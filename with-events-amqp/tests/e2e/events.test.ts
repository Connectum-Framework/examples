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

/**
 * POST a Connect unary call and return the raw outcome, errors included. The
 * Connect protocol maps a failed call to an HTTP status and a JSON body
 * `{ "code": "<lower_snake_case code>", "message": ... }`, which the error
 * tests below check against the protocol rather than against this example.
 */
async function connectRaw(baseUrl: string, method: string, body: Record<string, unknown> = {}): Promise<{ status: number; contentType: string | null; json: unknown }> {
    const res = await fetch(`${baseUrl}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: res.status, contentType: res.headers.get("content-type"), json: await res.json() };
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

// JSON omits an empty repeated field, so an empty list arrives as an absent key.
const getOrders = async (): Promise<Order[]> =>
    ((await connectPost(ORDER_URL, "orders.v1.OrderService/GetOrders", {})) as { orders?: Order[] }).orders ?? [];
const getReservations = async (): Promise<Reservation[]> =>
    ((await connectPost(INVENTORY_URL, "orders.v1.InventoryService/GetInventory", {})) as { reservations?: Reservation[] }).reservations ?? [];

const statusOf = (orders: Order[], orderId: string): string | undefined => orders.find((o) => o.orderId === orderId)?.status;
const reservationOf = (reservations: Reservation[], orderId: string): Reservation | undefined => reservations.find((r) => r.orderId === orderId);

describe("EventBus with AMQP/RabbitMQ — 2 Microservices + Saga", () => {
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

    it("saga: CreateOrder → InventoryReserved → order confirmed", async () => {
        const result = await connectPost(ORDER_URL, "orders.v1.OrderService/CreateOrder", {
            product: "Widget", quantity: 5, customer: "Alice",
        }) as { orderId: string; status: string };
        assert.ok(result.orderId);
        assert.equal(result.status, "pending");
        const orders = await eventually(getOrders, (o) => statusOf(o, result.orderId) === "confirmed", `order ${result.orderId} to be confirmed`);
        assert.equal(statusOf(orders, result.orderId), "confirmed", "Order should be confirmed after saga");
        // The order keeps everything the client sent.
        const order = orders.find((o) => o.orderId === result.orderId);
        assert.equal(order?.product, "Widget");
        assert.equal(order?.quantity, 5);
        assert.equal(order?.customer, "Alice");
        // The inventory side reserved exactly what was ordered: it learned the
        // product AND the quantity from the event that crossed the broker.
        const reservation = reservationOf(await getReservations(), result.orderId);
        assert.ok(reservation);
        assert.equal(reservation.status, "reserved");
        assert.equal(reservation.product, "Widget");
        assert.equal(reservation.quantity, 5);
    });

    it("every CreateOrder gets its own id", async () => {
        const first = (await connectPost(ORDER_URL, "orders.v1.OrderService/CreateOrder", { product: "Twin", quantity: 1, customer: "Eve" })) as { orderId: string };
        const second = (await connectPost(ORDER_URL, "orders.v1.OrderService/CreateOrder", { product: "Twin", quantity: 1, customer: "Eve" })) as { orderId: string };
        assert.ok(first.orderId);
        assert.ok(second.orderId);
        assert.notEqual(first.orderId, second.orderId);
    });

    it("CancelOrder for an unknown order is the Connect not_found error (HTTP 404)", async () => {
        const res = await connectRaw(ORDER_URL, "orders.v1.OrderService/CancelOrder", { orderId: "no-such-order", reason: "n/a" });
        assert.equal(res.status, 404);
        assert.match(res.contentType ?? "", /^application\/json/);
        assert.equal((res.json as { code: string }).code, "not_found");
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
        // Releasing flips the status of THIS reservation only; what it held stays on record.
        assert.equal(reservation.product, "Gadget");
        assert.equal(reservation.quantity, 2);
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
        const reservations = await eventually(getReservations, (r) => orderIds.every((id) => reservationOf(r, id) !== undefined), `reservations for ${orderIds.join(", ")}`);
        // Each order is reserved with its OWN product and quantity: events of
        // different orders must not be mixed up on their way through the broker.
        for (const [i, orderId] of orderIds.entries()) {
            const order = orders.find((o) => o.orderId === orderId);
            assert.ok(order, `Should find order ${orderId}`);
            assert.equal(order.status, "confirmed");
            assert.equal(order.product, `Product-${i}`);
            assert.equal(order.quantity, i + 1);
            assert.equal(order.customer, `Customer-${i}`);
            const reservation = reservationOf(reservations, orderId);
            assert.equal(reservation?.product, `Product-${i}`);
            assert.equal(reservation?.quantity, i + 1);
            assert.equal(reservation?.status, "reserved");
        }
        assert.equal(new Set(orderIds).size, orderIds.length);
    });
});
