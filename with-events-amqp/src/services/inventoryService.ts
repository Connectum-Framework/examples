import { create } from "@bufbuild/protobuf";
import { defineService } from "@connectum/core";
import {
    InventoryService,
    type GetInventoryRequest,
    GetInventoryResponseSchema,
    ReservationInfoSchema,
} from "#gen/orders/v1/orders_pb.ts";
import { reservations } from "./inventoryEvents.ts";

export const inventoryServiceRoutes = defineService(InventoryService, {
    async getInventory(_request: GetInventoryRequest) {
        return create(GetInventoryResponseSchema, {
            reservations: [...reservations.values()].map((r) => create(ReservationInfoSchema, r)),
        });
    },
});
