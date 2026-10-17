import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    INVENTORY_URL,
    ORDER_URL,
    connectPost,
    eventually,
    getOrders,
    getReservations,
    reservationOf,
    statusOf,
} from "./support.ts";

describe("EventBus with Redpanda — 2 Microservices + Saga", () => {
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
