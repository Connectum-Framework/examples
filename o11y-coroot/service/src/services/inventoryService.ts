import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { getLogger } from "@connectum/otel";
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

let _log: ReturnType<typeof getLogger> | undefined;
function log() { return (_log ??= getLogger("InventoryService")); }

export function inventoryServiceRoutes(router: ConnectRouter): void {
    router.service(InventoryService, {
        async getInventory(_request: GetInventoryRequest) {
            log().info(`Listing ${stock.size} product(s)`, {
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

            log().info(
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
