import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
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

export function inventoryServiceRoutes(router: ConnectRouter): void {
    router.service(InventoryService, {
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
}
