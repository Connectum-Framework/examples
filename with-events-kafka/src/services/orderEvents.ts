import type { EventRoute } from "@connectum/events";
import { OrderEventHandlers } from "#gen/orders/v1/orders_pb.ts";
import { orders } from "./orderService.ts";

export const orderEventRoutes: EventRoute = (events) => {
    events.service(OrderEventHandlers, {
        async onInventoryReserved(event, ctx) {
            console.log(`[OrderEvents] InventoryReserved for order ${event.orderId}: ${event.quantity}x ${event.product}`);
            const order = orders.get(event.orderId);
            if (order) {
                order.status = "confirmed";
                console.log(`[OrderEvents] Order ${event.orderId} status → confirmed`);
            }
            await ctx.ack();
        },
    });
};
