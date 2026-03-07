import { createEventBus } from "@connectum/events";
import { RedisAdapter } from "@connectum/events-redis";
import { inventoryEventRoutes } from "./services/inventoryEvents.ts";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

export const inventoryEventBus = createEventBus({
    adapter: RedisAdapter({ url: REDIS_URL }),
    routes: [inventoryEventRoutes],
    group: "inventory-service",
    middleware: { retry: { maxRetries: 3, backoff: "exponential" } },
});
