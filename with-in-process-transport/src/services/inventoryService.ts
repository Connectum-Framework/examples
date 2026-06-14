/**
 * InventoryService Implementation
 *
 * Simple in-memory stock manager. Demonstrates a callee that
 * other services in the same process invoke via `server.client(InventoryService)`.
 *
 * @module inventoryService
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
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
 * InventoryService definition.
 */
export const inventoryServiceRoutes = defineService(InventoryService, {
    async checkStock(request: CheckStockRequest) {
        // Read-tolerant by design: an unknown SKU reports `available: 0`
        // rather than throwing. A check is informational, whereas
        // `reserve` is a mutation that must fail loudly (NotFound) on a
        // missing SKU.
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
        // `quantity` is a signed int32 on the wire, so a negative value is
        // representable. Guard against it: without this check a negative
        // quantity passes `current < quantity` and *increases* stock via
        // `current - quantity`, corrupting inventory and reporting success.
        if (request.quantity <= 0) {
            throw new ConnectError(
                `quantity must be positive, got ${request.quantity}`,
                Code.InvalidArgument,
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
