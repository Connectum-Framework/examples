/**
 * Server factory for the in-process-transport example.
 *
 * Builds a single Connectum server that hosts both OrdersService and
 * InventoryService. The OrdersService routes are constructed *with* the
 * server instance so its handler can use `server.client(InventoryService)`
 * for in-process composition.
 *
 * @module server
 */

import { createServer } from "@connectum/core";
import type { Server } from "@connectum/core";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { inventoryServiceRoutes } from "#services/inventoryService.ts";
import { ordersServiceRoutes } from "#services/ordersService.ts";

/**
 * Build a Server hosting Orders + Inventory services.
 *
 * @param port - TCP port to bind (0 = random for tests).
 */
export function buildServer(port = 5000): Server {
    // Forward declaration: ordersService closes over the server, but the
    // server needs the routes up front. We create the routes lazily by
    // wrapping `ordersServiceRoutes(server)` after we have the instance.
    let serverRef: Server | undefined;

    const server = createServer({
        services: [
            inventoryServiceRoutes,
            // Lazy adapter: createServer() invokes route builders synchronously,
            // so we route through a closure that reads `serverRef` once it
            // has been assigned below.
            (router) => {
                if (!serverRef) {
                    throw new Error("server reference not yet bound");
                }
                ordersServiceRoutes(serverRef)(router);
            },
        ],
        port,
        host: "127.0.0.1",
        allowHTTP1: false,
        interceptors: createDefaultInterceptors(),
        shutdown: { timeout: 5_000 },
    });

    serverRef = server;
    return server;
}
