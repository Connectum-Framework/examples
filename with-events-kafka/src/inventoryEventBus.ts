import { createEventBus } from "@connectum/events";
import { KafkaAdapter } from "@connectum/events-kafka";
import { inventoryEventRoutes } from "./services/inventoryEvents.ts";

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");

export const inventoryEventBus = createEventBus({
    adapter: KafkaAdapter({ brokers: KAFKA_BROKERS, clientId: "inventory-service" }),
    routes: [inventoryEventRoutes],
    group: "inventory-service",
    middleware: { retry: { maxRetries: 3, backoff: "exponential" } },
});
