/**
 * Gateway authentication + authorization — applied uniformly across all roles.
 *
 * This is the "gateway auth at the edge" headline. The SAME interceptor chain is
 * mounted on every process role; what makes a service internal vs edge is its
 * proto annotation, not a per-role interceptor switch:
 *
 *  - `createJwtAuthInterceptor` verifies a Bearer JWT and populates the auth
 *    context. Phase 4 makes Connectum a thin IdP CONSUMER: the JWT is an RS256
 *    token minted at the edge by Ory Oathkeeper (which validated the Kratos
 *    session), and trips validates it against Oathkeeper's published JWKS
 *    (`jwksUri`, the `jose.createRemoteJWKSet` branch) — no shared secret, no
 *    identity logic in the app. `skipMethods` lists every method whose proto
 *    marks it `public` (fleet + billing are `service_auth { public: true }`),
 *    discovered automatically by `getPublicMethods`, plus the infra methods
 *    (health, reflection).
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

/**
 * JWT issuer this deployment trusts — the SINGLE SOURCE OF TRUTH for the `iss`
 * claim. It is a URL (Ory Oathkeeper's `issuer_url`), not an opaque string,
 * because Phase 4 mints RS256 tokens at the edge. The SAME value must be used by:
 *   - the trips interceptor `issuer` check (here, {@link buildAuthInterceptors});
 *   - the Oathkeeper `id_token` mutator `issuer_url` (`ory/oathkeeper/config.yml`);
 *   - the test mint's `iss` (the e2e imports this constant).
 * A mismatch in any of the three silently fails verification as `Unauthenticated`.
 * The compose default is the Oathkeeper proxy origin; override via `JWT_ISSUER`.
 */
export const JWT_ISSUER = "http://oathkeeper:4455/";

/** Default audience (`aud`) this gateway requires; override via `JWT_AUDIENCE`. */
export const JWT_AUDIENCE = "car-sharing-trips";

/** Options for {@link buildAuthInterceptors}. */
export interface BuildAuthOptions {
    /**
     * JWKS endpoint that publishes Oathkeeper's RS256 PUBLIC signing keys
     * (`createRemoteJWKSet` fetches it). In compose this is
     * `http://oathkeeper:4456/.well-known/jwks.json`; the e2e points it at an
     * in-process JWKS server so the production validation branch is exercised.
     */
    readonly jwksUri: string;
    /** JWT issuer claim to require. Defaults to {@link JWT_ISSUER}. */
    readonly issuer?: string;
    /** JWT audience claim to require. Defaults to {@link JWT_AUDIENCE}. */
    readonly audience?: string;
}

/**
 * Build the ordered gateway interceptors: JWT auth, then proto authz.
 *
 * Returned in chain order; the caller appends them after the default
 * interceptors. Identical across every process role.
 */
export function buildAuthInterceptors(options: BuildAuthOptions): Interceptor[] {
    const issuer = options.issuer ?? JWT_ISSUER;
    const audience = options.audience ?? JWT_AUDIENCE;

    // Public methods discovered from proto options: fleet.* and billing.* are
    // `service_auth { public: true }`, so every one of their RPCs is public.
    const publicMethods = getPublicMethods([FleetService, BillingService, TripService]);

    // RS256 + JWKS: the production `createRemoteJWKSet` branch. `algorithms`
    // pins RS256 so an HS256 token can't slip through; `issuer`/`audience` are
    // the trust boundary (a token from the wrong IdP or for the wrong API is
    // rejected as Unauthenticated). The mutator projects `roles`/`name` to
    // top-level claims, so `claimsMapping` reads them by their top-level keys.
    const jwtAuth = createJwtAuthInterceptor({
        jwksUri: options.jwksUri,
        issuer,
        audience,
        algorithms: ["RS256"],
        claimsMapping: {
            roles: "roles",
            name: "name",
        },
        skipMethods: [...publicMethods, "grpc.health.v1.Health/*", "grpc.reflection.v1.ServerReflection/*"],
    });

    const authz = createProtoAuthzInterceptor({ defaultPolicy: "deny" });

    return [jwtAuth, authz];
}
