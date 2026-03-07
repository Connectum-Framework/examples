import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { ConnectError, Code } from "@connectrpc/connect";
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

export function orderServiceRoutes(router: ConnectRouter): void {
    router.service(OrderService, {
        async createOrder(request: CreateOrderRequest) {
            const orderId = randomUUID();
            const order = { orderId, product: request.product, quantity: request.quantity, customer: request.customer, status: "pending" };
            console.log(`[OrderService] Creating order ${orderId}: ${request.quantity}x ${request.product} for ${request.customer}`);
            await orderEventBus.publish(OrderCreatedSchema, create(OrderCreatedSchema, {
                orderId, product: request.product, quantity: request.quantity, customer: request.customer,
            }));
            orders.set(orderId, order);
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
            }));
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
}
