import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { getLogger, getMeter } from "@connectum/otel";
import {
    InventoryService,
    type GetInventoryRequest,
    GetInventoryResponseSchema,
    InventoryItemSchema,
    type CheckStockRequest,
    CheckStockResponseSchema,
} from "#gen/orders/v1/orders_pb.ts";

/** Simulated inventory stock. */
const stock = new Map<string, number>([
    ["widget-1", 100],
    ["widget-2", 50],
    ["gadget-1", 200],
    ["gadget-2", 75],
    ["gizmo-1", 150],
]);

const logger = getLogger();

const meter = getMeter();
const stockChecks = meter.createCounter("inventory.stock_checks", { description: "Total stock check requests" });
const stockAvailable = meter.createCounter("inventory.stock_checks.available", { description: "Stock checks where product was available" });
const stockUnavailable = meter.createCounter("inventory.stock_checks.unavailable", { description: "Stock checks where product was unavailable" });

meter.createObservableGauge("inventory.stock_level", { description: "Current stock level per product" })
    .addCallback((result) => {
        for (const [productId, quantity] of stock) {
            result.observe(quantity, { "product.id": productId });
        }
    });

export function inventoryServiceRoutes(router: ConnectRouter): void {
    router.service(InventoryService, {
        async getInventory(_request: GetInventoryRequest) {
            logger.info(`Listing ${stock.size} product(s)`, {
                "inventory.count": stock.size,
            });

            return create(GetInventoryResponseSchema, {
                items: [...stock.entries()].map(([productId, quantity]) =>
                    create(InventoryItemSchema, {
                        productId,
                        quantity,
                        status: quantity > 0 ? "in_stock" : "out_of_stock",
                    }),
                ),
            });
        },

        async checkStock(request: CheckStockRequest) {
            const currentStock = stock.get(request.productId) ?? 0;
            const available = currentStock >= request.quantity;

            // Record metrics
            stockChecks.add(1, { "product.id": request.productId });
            if (available) {
                stockAvailable.add(1, { "product.id": request.productId });
            } else {
                stockUnavailable.add(1, { "product.id": request.productId });
            }

            logger.info(
                `Stock check: ${request.productId} available=${available} currentStock=${currentStock}`,
                {
                    "inventory.productId": request.productId,
                    "inventory.requestedQuantity": request.quantity,
                    "inventory.currentStock": currentStock,
                    "inventory.available": available,
                },
            );

            return create(CheckStockResponseSchema, {
                available,
                currentStock,
            });
        },
    });
}
