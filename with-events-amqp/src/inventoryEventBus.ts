import { createEventBus } from "@connectum/events";
import { AmqpAdapter } from "@connectum/events-amqp";
import { inventoryEventRoutes } from "./services/inventoryEvents.ts";

const AMQP_URL = process.env.AMQP_URL ?? "amqp://localhost:5672";

export const inventoryEventBus = createEventBus({
    adapter: AmqpAdapter({ url: AMQP_URL, exchange: "orders" }),
    routes: [inventoryEventRoutes],
    group: "inventory-service",
    middleware: { retry: { maxRetries: 3, backoff: "exponential" } },
});
