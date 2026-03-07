import { createEventBus } from "@connectum/events";
import { RedisAdapter } from "@connectum/events-redis";
import { orderEventRoutes } from "./services/orderEvents.ts";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

export const orderEventBus = createEventBus({
    adapter: RedisAdapter({ url: REDIS_URL }),
    routes: [orderEventRoutes],
    group: "order-service",
    middleware: { retry: { maxRetries: 3, backoff: "exponential" } },
});
