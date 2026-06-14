/**
 * BillingService — opens a billing tab for a trip (a leaf service).
 *
 * In-memory: each OpenTab mints a tab id and records it as open. Like
 * FleetService it is internal-only and marked `public` in its proto, so the
 * gateway auth/authz interceptors skip it on internal `ctx.call`s.
 *
 * @module services/billingService
 */

import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { defineService } from "@connectum/core";
import { BillingService, OpenTabResponseSchema, TabSchema } from "#gen/billing/v1/billing_pb.ts";

/** Demo ledger of open tabs (tab id → trip id). */
const tabs = new Map<string, string>();

/** Reset the ledger — used between tests. */
export function resetTabs(): void {
    tabs.clear();
}

/** Number of tabs currently recorded (used by tests to assert side effects). */
export function tabCount(): number {
    return tabs.size;
}

export const billingService = defineService(BillingService, {
    openTab: (req) => {
        const tabId = `tab-${randomUUID()}`;
        tabs.set(tabId, req.tripId);
        return create(OpenTabResponseSchema, {
            tab: create(TabSchema, { id: tabId, open: true }),
        });
    },
});
