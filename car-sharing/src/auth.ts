/**
 * Authentication + authorization — one interceptor chain for every role.
 *
 * The SAME chain is mounted on every process role; what makes a method
 * edge-facing or internal is its proto annotation, not a per-role switch. Two
 * kinds of caller reach this app, and each is authenticated by its own
 * interceptor:
 *
 *  - END USERS (StartTrip, GetTrip) — `createJwtAuthInterceptor` verifies a
 *    Bearer JWT. Phase 4 makes Connectum a thin IdP CONSUMER: the JWT is an
 *    RS256 token minted at the edge by Ory Oathkeeper (which validated the
 *    Kratos session), and trips validates it against Oathkeeper's published
 *    JWKS (`jwksUri`, the `jose.createRemoteJWKSet` branch) — no shared secret,
 *    no identity logic in the app. It skips the methods proto marks `public`
 *    or `internal` (discovered by `getPublicMethods` / `getInternalMethods`)
 *    plus the infra methods (health, reflection).
 *  - OTHER SERVICES (all of fleet and billing, and the trips RPCs RecordTrip /
 *    EndTrip, all `internal` in proto) — `createInternalAuthInterceptor` with
 *    `signedTokenTrust` requires a service token in `x-internal-token`, signed
 *    by the calling service's OWN key and verified against that service's
 *    JWKS, chosen by the token's issuer (see `#internalAuth.ts`). A missing,
 *    forged, expired or foreign-audience token is UNAUTHENTICATED. An end-user
 *    JWT is no substitute: the JWT interceptor skips internal methods, and the
 *    internal interceptor only looks at the service token.
 *
 * `createProtoAuthzInterceptor({ defaultPolicy: "deny" })` then reads the proto
 * `method_auth` / `service_auth` options: TripService's `default_policy:
 * "allow"` admits any authenticated user to StartTrip/GetTrip, and the internal
 * methods' `requires { roles }` admits only the listed service: the caller's
 * role is the issuer its key proved, never a claim inside the token (another
 * service's valid token is PERMISSION_DENIED).
 *
 * WHY internal callers need a token at all: a cross-service `ctx.call` (and the
 * worker's client) runs the full server interceptor chain, in-process and over
 * the network alike, and Connectum forwards no inbound header to it. The caller
 * therefore attaches its own service token; the in-process transport marker is
 * NOT treated as proof of trust, so the monolith verifies exactly like the
 * split deployment does.
 *
 * @module auth
 */

import type { Interceptor } from "@connectrpc/connect";
import { createInternalAuthInterceptor, createJwtAuthInterceptor } from "@connectum/auth";
import { createProtoAuthzInterceptor, getInternalMethods, getPublicMethods } from "@connectum/auth/proto";
import { BillingService } from "#gen/billing/v1/billing_pb.ts";
import { FleetService } from "#gen/fleet/v1/fleet_pb.ts";
import { TripService } from "#gen/trips/v1/trips_pb.ts";
import type { InternalIssuers } from "#internalAuth.ts";
import { issuerBoundTrust } from "#internalAuth.ts";

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
    /**
     * Services whose tokens are accepted on internal methods, keyed by the
     * token's `iss` (each with its own JWKS URL). See `internalIssuersFromEnv`.
     */
    readonly internalIssuers: InternalIssuers;
}

/**
 * Build the ordered auth interceptors: end-user JWT auth, service-token auth,
 * then proto authz.
 *
 * Returned in chain order; the caller appends them after the error handler.
 * Identical across every process role. Both authentication interceptors must
 * run before proto authz, because authz decides on the auth context they set.
 */
export function buildAuthInterceptors(options: BuildAuthOptions): Interceptor[] {
    const issuer = options.issuer ?? JWT_ISSUER;
    const audience = options.audience ?? JWT_AUDIENCE;

    const services = [FleetService, BillingService, TripService];
    // Discovered from proto options. No method is `public` today, but the JWT
    // interceptor still honours the annotation should one be added.
    const publicMethods = getPublicMethods(services);
    // fleet.* and billing.* (service-level) plus trips RecordTrip / EndTrip.
    const internalMethods = getInternalMethods(services);

    // RS256 + JWKS: the production `createRemoteJWKSet` branch. `algorithms`
    // pins RS256 so an HS256 token can't slip through; `issuer`/`audience` are
    // the trust boundary (a token from the wrong IdP or for the wrong API is
    // rejected as Unauthenticated). The mutator projects `roles`/`name` to
    // top-level claims, so `claimsMapping` reads them by their top-level keys.
    // Internal methods are skipped here because their caller is a service with
    // a service token, which the next interceptor checks.
    const jwtAuth = createJwtAuthInterceptor({
        jwksUri: options.jwksUri,
        issuer,
        audience,
        algorithms: ["RS256"],
        claimsMapping: {
            roles: "roles",
            name: "name",
        },
        skipMethods: [...publicMethods, ...internalMethods, "grpc.health.v1.Health/*", "grpc.reflection.v1.ServerReflection/*"],
    });

    // Per-service signed tokens: the keyset is chosen by the token's claimed
    // issuer and verification is pinned to that issuer, and the caller's role is
    // that verified issuer, so one service's key can never vouch for another
    // service. Non-internal methods pass through.
    const internalAuth = createInternalAuthInterceptor({
        internalMethods,
        trustSource: issuerBoundTrust(options.internalIssuers),
    });

    const authz = createProtoAuthzInterceptor({ defaultPolicy: "deny" });

    return [jwtAuth, internalAuth, authz];
}
