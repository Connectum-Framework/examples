# Ory Oathkeeper — the car-sharing edge (Phase 4)

This directory configures **Ory Oathkeeper** as the external edge in front of the
`trips` gateway. The headline of Phase 4 is that **Connectum is a thin identity
CONSUMER**: Ory Kratos owns users and sessions, Oathkeeper validates a session
and mints a signed JWT, and the Connectum `trips` service only **verifies** that
JWT. No identity logic enters `@connectum/*`.

## Request flow (compose `ory` profile)

```
Browser ──login──▶ Kratos (4433)              # owns users + sessions
   │  ory_kratos_session cookie
   │
   ▼  POST /trips.v1.TripService/StartTrip (cookie)
Oathkeeper proxy (4455)
   │  1. cookie_session  → Kratos /sessions/whoami   (validate the session)
   │  2. authorizer allow                            (any authenticated caller)
   │  3. id_token mutator → MINTS an RS256 JWT       (iss = issuer_url)
   ▼  Authorization: Bearer <RS256 JWT>   (Connect over HTTP/1.1)
trips gateway (5000)
   │  createJwtAuthInterceptor({ jwksUri })          ← createRemoteJWKSet branch
   │     validates signature (kid → JWK), iss, aud, exp
   │  createProtoAuthzInterceptor({ defaultPolicy: "deny" })
   ▼  internal gRPC ctx.call (signed service token in x-internal-token)
fleet  (`internal`: verifies the token against trips' own JWKS)
```

The JWKS the gateway consumes is Oathkeeper's **public** signing key, published at:

```
http://oathkeeper:4456/.well-known/jwks.json
```

This is the value of `OATHKEEPER_JWKS_URI` for the trips role in compose.

## The JWT contract

The `id_token` mutator (`config.yml`) projects the Kratos session to **top-level**
JWT claims so the gateway's `claimsMapping` reads them directly:

| Claim   | Source (mutator)                         | Read by trips                          |
| ------- | ---------------------------------------- | -------------------------------------- |
| `sub`   | `.Subject` (Kratos identity id)          | `AuthContext.subject` (required)       |
| `iss`   | `issuer_url`                             | interceptor `issuer` check             |
| `aud`   | `claims.aud` = `["car-sharing-trips"]`   | interceptor `audience` check           |
| `name`  | `.Extra.identity.traits.email`           | `claimsMapping.name`                   |
| `roles` | `.Extra.identity.traits.roles` (array)   | `claimsMapping.roles` → per-method authz |
| `exp`   | `ttl` (60s)                              | jose expiry                            |
| `kid`   | the signing key                          | jose JWKS key selection                |

`issuer_url` here **must equal** `JWT_ISSUER` in `src/auth.ts` (the single source
of truth, also the trips `JWT_ISSUER` env and the e2e mint's `iss`). A mismatch
silently fails verification as `Unauthenticated`.

## Edge transport: why Connect over HTTP/1.1

The Oathkeeper standalone reverse proxy proxies plain HTTP, not trailer-aware
gRPC, for a Node upstream. So in compose the trips role is started with
`ALLOW_HTTP1=true`, serving the all-unary `TripService` over the **Connect
protocol on HTTP/1.1** — a normal HTTP POST + JSON that Oathkeeper proxies
cleanly. Internal `ctx.call` hops and the gRPC e2e clients keep the h2c default
(`@connectum/core` serves either h2c OR HTTP/1.1 on a plaintext listener, not
both). Demo the edge with `curl` (Connect is plain HTTP), not `grpcurl`
(gRPC/HTTP2).

## The signing key is NOT in git

Oathkeeper's RS256 **private** signing keyset is generated at compose-up by a
one-shot (`oathkeeper credentials generate --alg RS256`) into a shared volume the
`oathkeeper` service mounts at `/etc/keys/id_token.jwks.json`. Nothing private is
committed. The dockerless e2e generates its own keypair in-memory
(`generateRsaTestKeypair` from `@connectum/auth/testing`), so no key is needed in
git there either.

## Kubernetes integration status

The Compose `ory` profile is the runnable Oathkeeper integration in this
repository. The `k8s/` and `istio/` manifests configure trips to validate JWTs
from an external JWKS issuer, but they do not deploy Oathkeeper or configure
Istio `ext_authz`; that edge integration remains to be implemented. A future
integration could use Oathkeeper's Decision API (`:4456/decisions`) as an
`ext_authz` provider while Envoy terminates gRPC, but the example does not
currently wire that flow. The Kubernetes gateway keeps its default h2c listener;
`ALLOW_HTTP1=true` is only used by the Compose standalone-proxy demo.

## Role-gating extension point

The minimal phase is role-agnostic: `roles` are carried end-to-end but
`TripService` stays `default_policy: "allow"`, so a valid JWT is enough. To gate
a future admin RPC by role, add to the proto **without touching the token
pipeline**:

```proto
rpc AdminRecallVehicle(...) returns (...) {
  option (connectum.auth.v1.method_auth) = { requires { roles: ["fleet_admin"] } };
}
```

In the Compose demo, the `roles` claim flows from the Kratos identity trait
through the Oathkeeper mutator and `claimsMapping` into `AuthContext.roles`,
which `createProtoAuthzInterceptor` reads.
