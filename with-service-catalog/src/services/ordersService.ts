/**
 * OrdersService — composes InventoryService via `ctx.call`.
 *
 * The handler issues two catalog calls (`CheckStock`, then `Reserve`). The
 * transport is chosen by the framework: because InventoryService is mounted on
 * the same server, both calls dispatch in-process — no client, no transport,
 * no forward reference to the server. Split InventoryService into its own
 * process and configure a `remoteResolver`, and the same two lines keep working.
 *
 * @module services/ordersService
 */

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import { CheckStockRequestSchema, ReserveRequestSchema } from "#gen/inventory/v1/inventory_pb.ts";
import { CreateOrderResponseSchema, OrdersService } from "#gen/orders/v1/orders_pb.ts";

export const ordersService = defineService(OrdersService, {
    async createOrder(req, ctx) {
        // Cross-service call #1 — typed by the generated catalog. Routed
        // in-process (InventoryService is local); the inbound deadline/signal
        // cascade automatically.
        const stock = await ctx.call("inventory.v1.InventoryService/CheckStock", create(CheckStockRequestSchema, { sku: req.sku }));

        if (stock.available < req.quantity) {
            throw new ConnectError(`Out of stock for "${req.sku}": have ${stock.available}, need ${req.quantity}.`, Code.FailedPrecondition);
        }

        // Cross-service call #2 — reserve the units.
        const reservation = await ctx.call("inventory.v1.InventoryService/Reserve", create(ReserveRequestSchema, { sku: req.sku, quantity: req.quantity }));

        return create(CreateOrderResponseSchema, {
            orderId: `order-${req.sku}-${req.customerId}`,
            reserved: reservation.reserved,
            remainingStock: reservation.remaining,
        });
    },
});
