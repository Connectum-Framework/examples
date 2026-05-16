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
import type { ConnectRouter } from "@connectrpc/connect";
import type { Server } from "@connectum/core";
import { InventoryService } from "#gen/inventory/v1/inventory_pb.ts";
import {
    type CreateOrderRequest,
    CreateOrderResponseSchema,
    OrdersService,
} from "#gen/orders/v1/orders_pb.ts";

/**
 * Build OrdersService routes wired to the provided server for in-process
 * composition.
 *
 * @param server - The Connectum server (used as a service registry).
 * @returns A function that registers OrdersService on a ConnectRouter.
 */
export function ordersServiceRoutes(server: Server) {
    return (router: ConnectRouter) => {
        router.service(OrdersService, {
            async createOrder(request: CreateOrderRequest) {
                // Polyglot routing: `server.client(InventoryService)`
                //   - if InventoryService is registered locally → uses createLocalTransport
                //     (no HTTP/2, no socket, no serialization across the wire);
                //   - if not registered, would fall back to `options.fallback` transport.
                const inventory = server.client(InventoryService);

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
    };
}
