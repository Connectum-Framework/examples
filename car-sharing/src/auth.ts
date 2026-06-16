/**
 * Gateway authentication + authorization — applied uniformly across all roles.
 *
 * This is the "gateway auth at the edge" headline. The SAME interceptor chain is
 * mounted on every process role; what makes a service internal vs edge is its
 * proto annotation, not a per-role interceptor switch:
 *
 *  - `createJwtAuthInterceptor` verifies a Bearer JWT and populates the auth
 *    context. `skipMethods` lists every method whose proto marks it `public`
 *    (fleet + billing are `service_auth { public: true }`), discovered
 *    automatically by `getPublicMethods`, plus the infra methods (health,
 *    reflection).
 *  - `createProtoAuthzInterceptor({ defaultPolicy: "deny" })` reads the proto
 *    `method_auth` / `service_auth` options at runtime. TripService declares
 *    `default_policy: "allow"`, so any AUTHENTICATED caller passes StartTrip;
 *    fleet/billing are `public`, so authz is skipped for them.
 *
 * WHY public matters for internal calls: a cross-service `ctx.call` re-runs the
 * full server interceptor chain (in-process and over the network alike) but
 * carries NO inbound Authorization header — Connectum does not auto-propagate
 * request headers across `ctx.call`. Without `public: true` on fleet/billing, an
 * internal call from the trip handler would be rejected as UNAUTHENTICATED by
 * this very chain. Marking the internal services public lets edge auth and
 * internal orchestration coexist on one uniform chain; the real network trust
 * boundary is enforced by Istio mTLS + AuthorizationPolicy (see istio/).
 *
 * @module auth
 */

import type { Interceptor } from "@connectrpc/connect";
import { createJwtAuthInterceptor } from "@connectum/auth";
import { createProtoAuthzInterceptor, getPublicMethods } from "@connectum/auth/proto";
import { BillingService } from "#gen/billing/v1/billing_pb.ts";
import { FleetService } from "#gen/fleet/v1/fleet_pb.ts";
import { TripService } from "#gen/trips/v1/trips_pb.ts";

/** JWT issuer this deployment trusts. */
export const JWT_ISSUER = "car-sharing-gateway";

/** Options for {@link buildAuthInterceptors}. */
export interface BuildAuthOptions {
    /** HMAC secret used to verify JWTs (from `JWT_SECRET` env in production). */
    readonly secret: string;
    /** JWT issuer claim to require. Defaults to {@link JWT_ISSUER}. */
    readonly issuer?: string;
}

/**
 * Build the ordered gateway interceptors: JWT auth, then proto authz.
 *
 * Returned in chain order; the caller appends them after the default
 * interceptors. Identical across every process role.
 */
export function buildAuthInterceptors(options: BuildAuthOptions): Interceptor[] {
    const issuer = options.issuer ?? JWT_ISSUER;

    // Public methods discovered from proto options: fleet.* and billing.* are
    // `service_auth { public: true }`, so every one of their RPCs is public.
    const publicMethods = getPublicMethods([FleetService, BillingService, TripService]);

    const jwtAuth = createJwtAuthInterceptor({
        secret: options.secret,
        issuer,
        claimsMapping: {
            roles: "roles",
            name: "name",
        },
        skipMethods: [...publicMethods, "grpc.health.v1.Health/*", "grpc.reflection.v1.ServerReflection/*"],
    });

    const authz = createProtoAuthzInterceptor({ defaultPolicy: "deny" });

    return [jwtAuth, authz];
}
