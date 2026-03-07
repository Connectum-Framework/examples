import { createEventBus } from "@connectum/events";
import { KafkaAdapter } from "@connectum/events-kafka";
import { inventoryEventRoutes } from "./services/inventoryEvents.ts";

const REDPANDA_BROKERS = (process.env.REDPANDA_BROKERS ?? "localhost:9092").split(",");

export const inventoryEventBus = createEventBus({
    adapter: KafkaAdapter({ brokers: REDPANDA_BROKERS, clientId: "inventory-service" }),
    routes: [inventoryEventRoutes],
    group: "inventory-service",
    middleware: { retry: { maxRetries: 3, backoff: "exponential" } },
});
