/**
 * OrdersService Implementation
 *
 * Demonstrates the **composition pattern**: the OrdersService handler
 * obtains an in-process client to InventoryService via `server.client(...)`
 * and invokes it without ever touching the network.
 *
 * The same handler code works unchanged whether InventoryService is
 * registered in this process (local invoke) or remote (fallback transport).
 *
 * @module ordersService
 */

import { create } from "@bufbuild/protobuf";
import { defineService } from "@connectum/core";
import type { Server, ServiceDefinition } from "@connectum/core";
import { InventoryService } from "#gen/inventory/v1/inventory_pb.ts";
import {
    type CreateOrderRequest,
    CreateOrderResponseSchema,
    OrdersService,
} from "#gen/orders/v1/orders_pb.ts";

/**
 * Build the OrdersService definition wired to the hosting server for
 * in-process composition.
 *
 * The server is read lazily through `getServer` so the definition can be
 * constructed before `createServer()` returns: the thunk is only invoked at
 * request time, by which point the server reference is bound.
 *
 * @param getServer - Resolver for the Connectum server (used as a service registry).
 * @returns The OrdersService definition.
 */
export function ordersServiceRoutes(getServer: () => Server): ServiceDefinition {
    return defineService(OrdersService, {
        async createOrder(request: CreateOrderRequest) {
            // Polyglot routing: `server.client(InventoryService)`
            //   - if InventoryService is registered locally → uses createLocalTransport
            //     (no HTTP/2, no socket, no serialization across the wire);
            //   - if not registered, would fall back to `options.fallback` transport.
            const inventory = getServer().client(InventoryService);

            const reservation = await inventory.reserve({
                sku: request.sku,
                quantity: request.quantity,
            });

            const orderId = reservation.reserved
                ? `ord_${Date.now().toString(36)}_${Math.random()
                      .toString(36)
                      .slice(2, 8)}`
                : "";

            return create(CreateOrderResponseSchema, {
                orderId,
                reserved: reservation.reserved,
                remainingStock: reservation.remaining,
            });
        },
    });
}
