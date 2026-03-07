import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import {
    InventoryService,
    type GetInventoryRequest,
    GetInventoryResponseSchema,
    ReservationInfoSchema,
} from "#gen/orders/v1/orders_pb.ts";
import { reservations } from "./inventoryEvents.ts";

export function inventoryServiceRoutes(router: ConnectRouter): void {
    router.service(InventoryService, {
        async getInventory(_request: GetInventoryRequest) {
            return create(GetInventoryResponseSchema, {
                reservations: [...reservations.values()].map((r) => create(ReservationInfoSchema, r)),
            });
        },
    });
}
