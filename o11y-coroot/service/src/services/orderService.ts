import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { createOtelClientInterceptor, getLogger, getMeter } from "@connectum/otel";
import {
    InventoryService,
    OrderService,
    type CreateOrderRequest,
    CreateOrderResponseSchema,
    type GetOrdersRequest,
    GetOrdersResponseSchema,
    OrderInfoSchema,
    type OrderItem,
} from "#gen/orders/v1/orders_pb.ts";

const INVENTORY_URL = process.env.INVENTORY_URL ?? "http://localhost:5001";
const inventoryUrl = new URL(INVENTORY_URL);

const inventoryTransport = createConnectTransport({
    baseUrl: INVENTORY_URL,
    httpVersion: "1.1",
    interceptors: [createOtelClientInterceptor({ serverAddress: inventoryUrl.hostname, serverPort: Number(inventoryUrl.port) })],
});
const inventoryClient = createClient(InventoryService, inventoryTransport);

interface StoredOrder {
    orderId: string;
    items: OrderItem[];
    status: string;
    createdAt: string;
}

const orders = new Map<string, StoredOrder>();
const logger = getLogger();

const meter = getMeter();
const ordersCreated = meter.createCounter("orders.created", { description: "Total number of orders created" });
const ordersItems = meter.createCounter("orders.items.total", { description: "Total number of items ordered" });
const ordersActive = meter.createUpDownCounter("orders.active", { description: "Number of active orders" });
const orderValue = meter.createHistogram("orders.value", { description: "Distribution of order sizes", unit: "items" });

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

            // Check stock availability via inventory-service
            const firstItem = request.items[0];
            if (firstItem) {
                const stockResult = await inventoryClient.checkStock({
                    productId: firstItem.productId,
                    quantity: firstItem.quantity,
                });
                logger.info(`Stock check: ${firstItem.productId} available=${stockResult.available}`, {
                    "inventory.productId": firstItem.productId,
                    "inventory.available": stockResult.available,
                });
            }

            orders.set(orderId, order);

            // Record metrics
            ordersCreated.add(1, { "product.id": request.items[0]?.productId ?? "unknown" });
            ordersItems.add(totalItems);
            ordersActive.add(1);
            orderValue.record(totalItems);

            const itemsSummary = request.items.map((i) => `${i.quantity}x ${i.productId}`).join(", ");
            logger.info(`Order created: order-${orderId.slice(0, 8)} — ${itemsSummary}`, {
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
            logger.info(`Listing ${orders.size} order(s)`, {
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
