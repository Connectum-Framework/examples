import { createEventBus } from "@connectum/events";
import { AmqpAdapter } from "@connectum/events-amqp";
import { orderEventRoutes } from "./services/orderEvents.ts";

const AMQP_URL = process.env.AMQP_URL ?? "amqp://localhost:5672";

export const orderEventBus = createEventBus({
    adapter: AmqpAdapter({ url: AMQP_URL, exchange: "orders" }),
    routes: [orderEventRoutes],
    group: "order-service",
    middleware: { retry: { maxRetries: 3, backoff: "exponential" } },
});
