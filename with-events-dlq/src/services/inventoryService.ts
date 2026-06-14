import { create } from "@bufbuild/protobuf";
import { defineService } from "@connectum/core";
import {
    InventoryService,
    type GetInventoryRequest,
    GetInventoryResponseSchema,
    ReservationInfoSchema,
    type GetDlqEventsRequest,
    GetDlqEventsResponseSchema,
    DlqEventInfoSchema,
} from "#gen/orders/v1/orders_pb.ts";
import { reservations, dlqEvents } from "./inventoryEvents.ts";

export const inventoryServiceRoutes = defineService(InventoryService, {
    async getInventory(_request: GetInventoryRequest) {
        return create(GetInventoryResponseSchema, {
            reservations: [...reservations.values()].map((r) => create(ReservationInfoSchema, r)),
        });
    },
    async getDlqEvents(_request: GetDlqEventsRequest) {
        return create(GetDlqEventsResponseSchema, {
            events: dlqEvents.map((e) => create(DlqEventInfoSchema, e)),
        });
    },
});
