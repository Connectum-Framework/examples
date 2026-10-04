import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    INVENTORY_URL,
    ORDER_URL,
    connectPost,
    connectRaw,
    eventually,
    getOrders,
    getReservations,
    reservationOf,
    statusOf,
} from "./support.ts";

describe("EventBus with Redpanda — 2 Microservices + Saga", () => {
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

    it("CreateOrder with quantity 0 or less is the Connect invalid_argument error (HTTP 400) and creates no order", async () => {
        const before = (await getOrders()).length;
        for (const quantity of [0, -1]) {
            const res = await connectRaw(ORDER_URL, "orders.v1.OrderService/CreateOrder", { product: "Widget", quantity, customer: "Mallory" });
            assert.equal(res.status, 400, `quantity ${quantity}`);
            assert.match(res.contentType ?? "", /^application\/json/);
            assert.equal((res.json as { code: string }).code, "invalid_argument", `quantity ${quantity}`);
        }
        assert.equal((await getOrders()).length, before, "a rejected request must not store an order");
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
