import { createEventBus } from "@connectum/events";
import { KafkaAdapter } from "@connectum/events-kafka";
import { orderEventRoutes } from "./services/orderEvents.ts";

const REDPANDA_BROKERS = (process.env.REDPANDA_BROKERS ?? "localhost:9092").split(",");

export const orderEventBus = createEventBus({
    adapter: KafkaAdapter({
        brokers: REDPANDA_BROKERS,
        clientId: "order-service",
        // A fresh demo broker has none of the topics yet, and the adapter does not
        // create topics unless told to. Production clusters create their topics up
        // front, so a misspelled topic fails instead of appearing silently.
        consumerOptions: { allowAutoTopicCreation: true },
    }),
    routes: [orderEventRoutes],
    group: "order-service",
    middleware: { retry: { maxRetries: 3, backoff: "exponential" } },
});
