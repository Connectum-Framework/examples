import { createEventBus } from "@connectum/events";
import { AmqpAdapter } from "@connectum/events-amqp";
import { logSetupFailures } from "./amqpFailureReporting.ts";
import { orderEventRoutes } from "./services/orderEvents.ts";

const AMQP_URL = process.env.AMQP_URL ?? "amqp://localhost:5672";
// The quick start always uses "orders". The override exists for the fail-fast
// e2e check, which points one short-lived service at a conflicting exchange
// without touching the exchange the running stack uses.
const AMQP_EXCHANGE = process.env.AMQP_EXCHANGE ?? "orders";

export const orderEventBus = createEventBus({
    adapter: AmqpAdapter({
        url: AMQP_URL,
        exchange: AMQP_EXCHANGE,
        // A broker that refuses the topology (an exchange of another type, a
        // queue with other arguments) will refuse it again on every retry:
        // reject start() with AmqpTopologyError instead of hanging. A broker
        // that is merely unreachable stays in normal recovery and connects
        // when it appears.
        failFastOnInitialSetupError: true,
        lifecycle: { onLifecycle: logSetupFailures("order-service") },
    }),
    routes: [orderEventRoutes],
    group: "order-service",
    middleware: { retry: { maxRetries: 3, backoff: "exponential" } },
});
