/**
 * InventoryService — a leaf service with an in-memory stock ledger.
 *
 * Defined with `defineService`: its handlers receive a Connectum `ctx`, but
 * this service makes no cross-service calls of its own.
 *
 * @module services/inventoryService
 */

import { create } from "@bufbuild/protobuf";
import { defineService } from "@connectum/core";
import { CheckStockResponseSchema, InventoryService, ReserveResponseSchema } from "#gen/inventory/v1/inventory_pb.ts";

/** Initial demo stock (SKU → units available). */
const INITIAL_STOCK: ReadonlyArray<readonly [string, number]> = [
    ["widget", 10],
    ["gadget", 3],
];

/** Demo stock ledger (SKU → units available). */
const stock = new Map<string, number>(INITIAL_STOCK.map(([sku, n]) => [sku, n]));

/** Reset the ledger to its initial state — used between tests. */
export function resetStock(): void {
    stock.clear();
    for (const [sku, n] of INITIAL_STOCK) stock.set(sku, n);
}

export const inventoryService = defineService(InventoryService, {
    checkStock: (req) => create(CheckStockResponseSchema, { sku: req.sku, available: stock.get(req.sku) ?? 0 }),

    reserve: (req) => {
        const available = stock.get(req.sku) ?? 0;
        if (available < req.quantity) {
            return create(ReserveResponseSchema, { reserved: false, remaining: available });
        }
        const remaining = available - req.quantity;
        stock.set(req.sku, remaining);
        return create(ReserveResponseSchema, { reserved: true, remaining });
    },
});
