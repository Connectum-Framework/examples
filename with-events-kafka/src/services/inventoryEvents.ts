import { create } from "@bufbuild/protobuf";
import type { EventRoute } from "@connectum/events";
import { InventoryEventHandlers, InventoryReservedSchema } from "#gen/orders/v1/orders_pb.ts";
import { inventoryEventBus } from "../inventoryEventBus.ts";

export const reservations = new Map<string, { orderId: string; product: string; quantity: number; status: string }>();

export const inventoryEventRoutes: EventRoute = (events) => {
    events.service(InventoryEventHandlers, {
        async onOrderCreated(event, ctx) {
            console.log(`[InventoryEvents] OrderCreated received: ${event.orderId} — ${event.quantity}x ${event.product}`);
            reservations.set(event.orderId, { orderId: event.orderId, product: event.product, quantity: event.quantity, status: "reserved" });
            await inventoryEventBus.publish(InventoryReservedSchema, create(InventoryReservedSchema, {
                orderId: event.orderId, product: event.product, quantity: event.quantity,
            }));
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
