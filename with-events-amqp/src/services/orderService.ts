import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { ConnectError, Code } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import {
    OrderService,
    type CreateOrderRequest,
    CreateOrderResponseSchema,
    OrderCreatedSchema,
    type CancelOrderRequest,
    CancelOrderResponseSchema,
    OrderCancelledSchema,
    type GetOrdersRequest,
    GetOrdersResponseSchema,
    OrderInfoSchema,
} from "#gen/orders/v1/orders_pb.ts";
import { orderEventBus } from "../orderEventBus.ts";

export const orders = new Map<string, { orderId: string; product: string; quantity: number; customer: string; status: string }>();

export const orderServiceRoutes = defineService(OrderService, {
    async createOrder(request: CreateOrderRequest) {
        const orderId = randomUUID();
        const order = { orderId, product: request.product, quantity: request.quantity, customer: request.customer, status: "pending" };
        console.log(`[OrderService] Creating order ${orderId}: ${request.quantity}x ${request.product} for ${request.customer}`);
        // The order is stored before its event goes out: the inventory service
        // answers with InventoryReserved, and that reply can reach this process
        // before the publish settles (the broker confirms a publish only after
        // it has accepted the message, while consumers receive it at once).
        // A handler that looks up an order which is not stored yet would drop
        // the confirmation and leave the order pending forever.
        orders.set(orderId, order);
        try {
            await orderEventBus.publish(OrderCreatedSchema, create(OrderCreatedSchema, {
                orderId, product: request.product, quantity: request.quantity, customer: request.customer,
            }));
        } catch (err) {
            orders.delete(orderId);
            throw err;
        }
        console.log(`[OrderService] OrderCreated event published for ${orderId}`);
        return create(CreateOrderResponseSchema, { orderId, status: "pending" });
    },
    async cancelOrder(request: CancelOrderRequest) {
        const order = orders.get(request.orderId);
        if (!order) {
            throw new ConnectError(`Order ${request.orderId} not found`, Code.NotFound);
        }
        console.log(`[OrderService] Cancelling order ${request.orderId}: ${request.reason}`);
        await orderEventBus.publish(OrderCancelledSchema, create(OrderCancelledSchema, {
            orderId: request.orderId, reason: request.reason,
        }), { topic: "orders.cancelled" });
        order.status = "cancelled";
        console.log(`[OrderService] OrderCancelled event published for ${request.orderId}`);
        return create(CancelOrderResponseSchema, { orderId: request.orderId, status: "cancelled" });
    },
    async getOrders(_request: GetOrdersRequest) {
        return create(GetOrdersResponseSchema, {
            orders: [...orders.values()].map((o) => create(OrderInfoSchema, o)),
        });
    },
});
