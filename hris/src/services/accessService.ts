/**
 * AccessService — provisions and revokes system access (the IT side of
 * onboarding).
 *
 * A leaf service with an in-memory account ledger. It is the onboarding saga's
 * fourth forward step: `provisionAccess` creates an account for the new hire,
 * and its compensation `revokeAccess` removes it. Both are IDEMPOTENT so a saga
 * unwind that runs after a partially-applied step is a no-op success.
 *
 * @module services/accessService
 */

import { create } from "@bufbuild/protobuf";
import { defineService } from "@connectum/core";
import { AccessSchema, AccessService, ProvisionAccessResponseSchema } from "#gen/access/v1/access_pb.ts";
import { empty } from "#empty.ts";

/** A provisioned account record keyed by employee id. */
interface AccessRecord {
    employeeId: string;
    accountId: string;
    email: string;
}

/** Demo account ledger (employee id → provisioned account). */
const accounts = new Map<string, AccessRecord>();

/** Reset the ledger — used between tests. */
export function resetAccess(): void {
    accounts.clear();
}

/** Number of provisioned accounts (used by tests to assert side effects). */
export function accessCount(): number {
    return accounts.size;
}

/** True when an account exists for `employeeId` (test/inspection helper). */
export function isProvisioned(employeeId: string): boolean {
    return accounts.has(employeeId);
}

/** Derive a stable demo account id for an employee. */
function accountIdFor(employeeId: string): string {
    return `acct-${employeeId}`;
}

export const accessService = defineService(AccessService, {
    // Provision (or return the existing) account. Idempotent by employee id.
    provisionAccess(req) {
        let record = accounts.get(req.employeeId);
        if (record === undefined) {
            record = { employeeId: req.employeeId, accountId: accountIdFor(req.employeeId), email: req.email };
            accounts.set(req.employeeId, record);
        }
        return create(ProvisionAccessResponseSchema, {
            access: create(AccessSchema, { employeeId: record.employeeId, accountId: record.accountId, provisioned: true }),
        });
    },

    // Compensation — remove the account. Idempotent: a no-op for an unknown
    // employee (returns success either way).
    revokeAccess(req) {
        accounts.delete(req.employeeId);
        return empty();
    },
});
