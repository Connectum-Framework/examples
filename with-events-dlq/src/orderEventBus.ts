import { createEventBus } from "@connectum/events";
import { NatsAdapter } from "@connectum/events-nats";
import { orderEventRoutes } from "./services/orderEvents.ts";

const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";

export const orderEventBus = createEventBus({
    adapter: NatsAdapter({ servers: NATS_URL, stream: "orders" }),
    routes: [orderEventRoutes],
    group: "order-service",
    middleware: {
        retry: { maxRetries: 2, backoff: "fixed", initialDelay: 200 },
        dlq: { topic: "dead-letter-queue" },
    },
});
