import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { getLogger } from "@connectum/otel";
import {
    OrderService,
    type CreateOrderRequest,
    CreateOrderResponseSchema,
    type GetOrdersRequest,
    GetOrdersResponseSchema,
    OrderInfoSchema,
    type OrderItem,
} from "#gen/orders/v1/orders_pb.ts";

interface StoredOrder {
    orderId: string;
    items: OrderItem[];
    status: string;
    createdAt: string;
}

const orders = new Map<string, StoredOrder>();
let _log: ReturnType<typeof getLogger> | undefined;
function log() { return (_log ??= getLogger("OrderService")); }

export function orderServiceRoutes(router: ConnectRouter): void {
    router.service(OrderService, {
        async createOrder(request: CreateOrderRequest) {
            const orderId = randomUUID();
            const totalItems = request.items.reduce((sum, item) => sum + item.quantity, 0);

            const order: StoredOrder = {
                orderId,
                items: [...request.items],
                status: "confirmed",
                createdAt: new Date().toISOString(),
            };

            orders.set(orderId, order);

            const itemsSummary = request.items.map((i) => `${i.quantity}x ${i.productId}`).join(", ");
            log().info(`Order created: order-${orderId.slice(0, 8)} — ${itemsSummary}`, {
                "order.id": orderId,
                "order.totalItems": totalItems,
                "order.status": "confirmed",
            });

            return create(CreateOrderResponseSchema, {
                orderId,
                status: "confirmed",
                totalItems,
            });
        },

        async getOrders(_request: GetOrdersRequest) {
            log().info(`Listing ${orders.size} order(s)`, {
                "order.count": orders.size,
            });

            return create(GetOrdersResponseSchema, {
                orders: [...orders.values()].map((o) =>
                    create(OrderInfoSchema, {
                        orderId: o.orderId,
                        items: o.items,
                        status: o.status,
                        createdAt: o.createdAt,
                    }),
                ),
            });
        },
    });
}
