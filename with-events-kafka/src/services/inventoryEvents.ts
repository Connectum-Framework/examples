import { create } from "@bufbuild/protobuf";
import type { EventRoute } from "@connectum/events";
import { InventoryEventHandlers, InventoryReservedSchema } from "#gen/orders/v1/orders_pb.ts";
import { inventoryEventBus } from "../inventoryEventBus.ts";
import { MAX_RETRIES } from "../retryPolicy.ts";

export const reservations = new Map<string, { orderId: string; product: string; quantity: number; status: string; deliveries: number }>();

// An order for this product makes the handler fail until the retry middleware has
// used up its retries, so the failure reaches the adapter and the message is
// redelivered. Every other product is handled on the first run.
const FLAKY_PRODUCT = "FLAKY";
const FLAKY_FAILING_RUNS = MAX_RETRIES + 1;

// Handler runs per order, failed ones included.
const runs = new Map<string, number>();

export const inventoryEventRoutes: EventRoute = (events) => {
    events.service(InventoryEventHandlers, {
        async onOrderCreated(event, ctx) {
            const run = (runs.get(event.orderId) ?? 0) + 1;
            runs.set(event.orderId, run);
            console.log(`[InventoryEvents] OrderCreated received: ${event.orderId} — ${event.quantity}x ${event.product} (run ${run})`);

            if (event.product === FLAKY_PRODUCT && run <= FLAKY_FAILING_RUNS) {
                throw new Error(`Simulated failure for product ${FLAKY_PRODUCT} (order ${event.orderId}, run ${run})`);
            }

            reservations.set(event.orderId, { orderId: event.orderId, product: event.product, quantity: event.quantity, status: "reserved", deliveries: run });
            await inventoryEventBus.publish(InventoryReservedSchema, create(InventoryReservedSchema, {
                orderId: event.orderId, product: event.product, quantity: event.quantity,
            }), { topic: "inventory.reserved" });
            console.log(`[InventoryEvents] InventoryReserved published for ${event.orderId}`);
            await ctx.ack();
        },
        async onOrderCancelled(event, ctx) {
            console.log(`[InventoryEvents] OrderCancelled received: ${event.orderId} — ${event.reason}`);
            const reservation = reservations.get(event.orderId);
            if (reservation) {
                reservation.status = "released";
                console.log(`[InventoryEvents] Reservation ${event.orderId} released`);
            }
            await ctx.ack();
        },
    });
};
