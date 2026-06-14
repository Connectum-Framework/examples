/**
 * Server factory for the service-catalog example.
 *
 * Hosts OrdersService + InventoryService in one process and passes the
 * generated `serviceCatalog`. Note what is NOT here: no per-service transport,
 * no `server.client()` wiring, and (unlike the in-process-transport example) no
 * forward reference to the server instance. `ctx.call` resolves the target at
 * call time, so the routes are plain values.
 *
 * @module server
 */

import { createServer } from "@connectum/core";
import type { Server } from "@connectum/core";
import { serviceCatalog } from "#gen/catalog.gen.ts";
import { inventoryService } from "#services/inventoryService.ts";
import { ordersService } from "#services/ordersService.ts";

/**
 * Build a Server hosting Orders + Inventory.
 *
 * @param port - TCP port to bind (0 = random for tests).
 */
export function buildServer(port = 5000): Server {
    return createServer({
        services: [ordersService, inventoryService],
        catalog: serviceCatalog,
        port,
        host: "127.0.0.1",
        allowHTTP1: false,
        shutdown: { timeout: 5_000 },
    });
}
