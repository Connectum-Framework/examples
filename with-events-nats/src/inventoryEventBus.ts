import { createEventBus } from "@connectum/events";
import { NatsAdapter } from "@connectum/events-nats";
import { inventoryEventRoutes } from "./services/inventoryEvents.ts";

const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";

export const inventoryEventBus = createEventBus({
    adapter: NatsAdapter({ servers: NATS_URL, stream: "orders" }),
    routes: [inventoryEventRoutes],
    group: "inventory-service",
    middleware: { retry: { maxRetries: 3, backoff: "exponential" } },
});
