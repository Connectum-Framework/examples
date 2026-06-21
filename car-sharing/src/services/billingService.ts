/**
 * BillingService — the trip billing ledger (a leaf service, in-memory).
 *
 * Phase 2: the ledger grows from "open tabs" to the full set the saga's
 * activities drive — OpenTab / AddCharge / Settle and their compensations
 * VoidTab / RefundCharge. The DURABLE billing state lives in the Temporal
 * workflow history; this in-memory store only needs to record enough (tab state
 * keyed by trip id, charges keyed by charge id) for the compensations to be
 * IDEMPOTENT, which is the property the saga relies on:
 *
 *  - OpenTab is idempotent by trip id (re-open returns the same tab).
 *  - VoidTab on a missing/already-void tab is a no-op success.
 *  - RefundCharge on a missing/already-refunded charge is a no-op success.
 *
 * Like FleetService it is internal-only and `public` in proto, so the gateway
 * auth/authz interceptors skip it on the worker's tokenless ConnectRPC calls.
 *
 * @module services/billingService
 */

import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import {
    AddChargeResponseSchema,
    BillingService,
    OpenTabResponseSchema,
    RefundChargeResponseSchema,
    SettleResponseSchema,
    TabSchema,
    VoidTabResponseSchema,
} from "#gen/billing/v1/billing_pb.ts";

/** A billing tab's lifecycle in the demo ledger. */
type TabState = "open" | "settled" | "void";

/** A tab record keyed by trip id. */
interface TabRecord {
    id: string;
    state: TabState;
}

/** A charge record keyed by charge id. */
interface ChargeRecord {
    id: string;
    tripId: string;
    amountCents: bigint;
    refunded: boolean;
}

/** Demo ledger: tabs keyed by trip id. */
const tabs = new Map<string, TabRecord>();
/** Demo ledger: charges keyed by charge id. */
const charges = new Map<string, ChargeRecord>();

/** Reset the tab ledger — used between tests. */
export function resetTabs(): void {
    tabs.clear();
}

/** Reset the charge ledger — used between tests. */
export function resetCharges(): void {
    charges.clear();
}

/** Reset BOTH ledgers — convenience for the saga/activity tests. */
export function resetBilling(): void {
    resetTabs();
    resetCharges();
}

/** Number of tabs currently recorded (used by tests to assert side effects). */
export function tabCount(): number {
    return tabs.size;
}

/** Number of OPEN tabs currently recorded (settled/void excluded). */
export function openTabCount(): number {
    let n = 0;
    for (const tab of tabs.values()) {
        if (tab.state === "open") n += 1;
    }
    return n;
}

/** Number of charges currently recorded (used by tests to assert side effects). */
export function chargeCount(): number {
    return charges.size;
}

/** Number of NON-refunded charges (used by tests to assert refund compensation). */
export function activeChargeCount(): number {
    let n = 0;
    for (const charge of charges.values()) {
        if (!charge.refunded) n += 1;
    }
    return n;
}

export const billingService = defineService(BillingService, {
    // OpenTab is idempotent by trip id: a re-open returns the existing tab.
    openTab: (req) => {
        const existing = tabs.get(req.tripId);
        if (existing !== undefined) {
            return create(OpenTabResponseSchema, { tab: create(TabSchema, { id: existing.id, open: existing.state === "open" }) });
        }
        const id = `tab-${randomUUID()}`;
        tabs.set(req.tripId, { id, state: "open" });
        return create(OpenTabResponseSchema, { tab: create(TabSchema, { id, open: true }) });
    },

    // AddCharge appends a charge line; mints and returns the charge id.
    addCharge: (req) => {
        const id = `charge-${randomUUID()}`;
        charges.set(id, { id, tripId: req.tripId, amountCents: req.amountCents, refunded: false });
        return create(AddChargeResponseSchema, { chargeId: id });
    },

    // Settle finalizes the tab. FAILED_PRECONDITION if there is no tab.
    settle: (req) => {
        const tab = tabs.get(req.tripId);
        if (tab === undefined) {
            throw new ConnectError(`No billing tab for trip "${req.tripId}".`, Code.FailedPrecondition);
        }
        tab.state = "settled";
        return create(SettleResponseSchema, { tab: create(TabSchema, { id: tab.id, open: false }) });
    },

    // VoidTab is the OpenTab compensation. Idempotent: missing/already-void → no-op.
    voidTab: (req) => {
        const tab = tabs.get(req.tripId);
        if (tab === undefined) {
            return create(VoidTabResponseSchema, { voided: false });
        }
        tab.state = "void";
        return create(VoidTabResponseSchema, { voided: true });
    },

    // RefundCharge is the AddCharge compensation. Idempotent: missing/already-refunded → no-op.
    refundCharge: (req) => {
        const charge = charges.get(req.chargeId);
        if (charge === undefined) {
            return create(RefundChargeResponseSchema, { refunded: false });
        }
        charge.refunded = true;
        return create(RefundChargeResponseSchema, { refunded: true });
    },
});
