/**
 * InventoryService Implementation
 *
 * Simple in-memory stock manager. Demonstrates a callee that
 * other services in the same process invoke via `server.client(InventoryService)`.
 *
 * @module inventoryService
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import {
    type CheckStockRequest,
    CheckStockResponseSchema,
    InventoryService,
    type ReserveRequest,
    ReserveResponseSchema,
} from "#gen/inventory/v1/inventory_pb.ts";

/**
 * In-memory stock table — pre-seeded with a couple of SKUs.
 * Exported so tests can reset/inspect state.
 */
export const stock: Map<string, number> = new Map([
    ["SKU-1", 100],
    ["SKU-2", 50],
]);

/** Reset stock to its initial state (for tests). */
export function resetStock(): void {
    stock.clear();
    stock.set("SKU-1", 100);
    stock.set("SKU-2", 50);
}

/**
 * Register InventoryService routes on a ConnectRouter.
 */
export function inventoryServiceRoutes(router: ConnectRouter): void {
    router.service(InventoryService, {
        async checkStock(request: CheckStockRequest) {
            const available = stock.get(request.sku) ?? 0;
            return create(CheckStockResponseSchema, {
                sku: request.sku,
                available,
            });
        },

        async reserve(request: ReserveRequest) {
            const current = stock.get(request.sku);
            if (current === undefined) {
                throw new ConnectError(
                    `SKU not found: ${request.sku}`,
                    Code.NotFound,
                );
            }
            if (current < request.quantity) {
                return create(ReserveResponseSchema, {
                    reserved: false,
                    remaining: current,
                });
            }
            const remaining = current - request.quantity;
            stock.set(request.sku, remaining);
            return create(ReserveResponseSchema, {
                reserved: true,
                remaining,
            });
        },
    });
}
