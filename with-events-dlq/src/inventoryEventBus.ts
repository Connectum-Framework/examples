import { createEventBus } from "@connectum/events";
import { NatsAdapter } from "@connectum/events-nats";
import { inventoryEventRoutes } from "./services/inventoryEvents.ts";

const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";

const adapter = NatsAdapter({ servers: NATS_URL, stream: "orders" });

export { adapter as inventoryAdapter };

export const inventoryEventBus = createEventBus({
    adapter,
    routes: [inventoryEventRoutes],
    group: "inventory-service",
    middleware: {
        retry: { maxRetries: 2, backoff: "fixed", initialDelay: 200 },
        dlq: { topic: "dead-letter-queue" },
    },
});
