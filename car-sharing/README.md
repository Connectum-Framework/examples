# car-sharing — enterprise deployment on Kubernetes + Istio

A surface-level car-sharing app whose headline is **production deployment**: one
Connectum image runs as three microservices on Kubernetes behind an Istio mesh,
showing three things that are normally hard, wired straight from the framework:

- **Gateway auth at the edge** — RS256 JWT authentication (validated via JWKS) +
  proto-driven authorization (`@connectum/auth`) on the public-facing `trips`
  service. The token is minted by **Ory** (Kratos + Oathkeeper); Connectum is a
  thin identity CONSUMER, not an IdP — see [Phase 4](#phase-4--ory-as-the-idp).
- **Cross-service `ctx.call` across split pods** — the trip handler calls fleet
  through the typed service catalog (availability pre-check); the framework picks
  in-process or network transport from env, no handler changes.
- **OpenTelemetry observability** — RPC tracing/metrics (`@connectum/otel`),
  enabled per role by env, on top of Istio's mesh telemetry.

The product is deliberately shallow. The value is the deployment + framework
wiring.

## Domain

| Service                   | Role            | RPC                          | Auth                                  |
| ------------------------- | --------------- | ---------------------------- | ------------------------------------- |
| `trips.v1.TripService`    | edge / gateway  | `StartTrip(userId, vehicle)`, `GetTrip(tripId)` | RS256 JWT required, validated via JWKS (minted by Ory Oathkeeper; proto `default_policy: allow`); `RecordTrip`/`EndTrip` method-level `public` (internal, worker-only) |
| `fleet.v1.FleetService`   | internal leaf   | `GetVehicle`, `ListVehicles` (stream), `ReserveVehicle`, `ReleaseVehicle` | `public` (proto `service_auth.public`) |
| `billing.v1.BillingService` | internal leaf | `OpenTab`, `AddCharge`, `Settle`, `VoidTab`, `RefundCharge` | `public`                              |

`FleetService` is backed by a real database (Drizzle ORM + Postgres) — see
[Persistence](#persistence-fleetservice--drizzle--postgres). The trip/billing
services remain in-memory (durable state lives in Temporal workflow history).

`StartTrip` does a **synchronous availability pre-check** (`ctx.call` to
`FleetService/GetVehicle`) — unavailable vehicle → `FAILED_PRECONDITION`;
unknown id → `NOT_FOUND` (propagated from fleet) — then **starts a durable
`TripWorkflow`** and returns immediately with `{ trip, workflow_id }`. Live
status is read via `GetTrip`. See [Phase 2](#phase-2--durable-saga-with-temporal)
for the full saga.

## Architecture

```mermaid
flowchart TB
    client([External gRPC client<br/>Bearer JWT])

    subgraph mesh["Istio mesh — namespace car-sharing (mTLS STRICT)"]
        ingress[Istio ingress gateway<br/>TLS termination + routing]

        subgraph trips["trips Deployment (gateway)"]
            tripsApp[TripService<br/>JWT auth + proto authz]
        end
        subgraph fleet["fleet Deployment (internal)"]
            fleetApp[FleetService<br/>public]
        end
        subgraph billing["billing Deployment (internal)"]
            billingApp[BillingService<br/>public]
        end

        otel[(OpenTelemetry<br/>Collector)]
    end

    client -->|"/trips.v1.TripService/StartTrip"| ingress
    ingress -->|"AuthorizationPolicy:<br/>ingress SA only"| tripsApp
    tripsApp -->|"ctx.call GetVehicle<br/>(pre-check, FLEET_ADDR)"| fleetApp
    tripsApp -.->|"starts TripWorkflow<br/>(Temporal client)"| temporal[(Temporal<br/>cluster)]
    temporal -->|"worker activities<br/>(ReserveVehicle…)"| fleetApp
    temporal -->|"worker activities<br/>(RecordTrip, EndTrip…)"| tripsApp
    temporal -->|"worker activities<br/>(OpenTab, AddCharge, Settle…)"| billingApp

    fleetApp -. "AuthorizationPolicy:<br/>trips SA only" .-> tripsApp
    billingApp -. "AuthorizationPolicy:<br/>trips SA only" .-> tripsApp

    tripsApp -.->|OTLP| otel
    fleetApp -.->|OTLP| otel
    billingApp -.->|OTLP| otel
```

### Why `public` on the internal services

A cross-service `ctx.call` re-runs the **full server interceptor chain** (in
monolith and split mode alike) but carries **no inbound `Authorization` header** —
Connectum does not auto-propagate request headers across `ctx.call`. If fleet and
billing required JWT auth, the trip handler's internal calls would be rejected as
`UNAUTHENTICATED` by the very chain that protects the edge.

So fleet and billing are marked `public` in proto (`service_auth { public: true }`),
which skips authn + authz for them. The real trust boundary is the **mesh**:
Istio `PeerAuthentication` (mTLS STRICT) + `AuthorizationPolicy` admit fleet/billing
traffic only from the `trips` ServiceAccount. The gateway authenticates external
clients; the mesh guarantees internal services are reachable solely by the gateway.

### One image, role by env

The same image is the monolith and every microservice role; `SERVICES` selects
what each process mounts locally, and `*_ADDR` env vars tell `ctx.call` where the
remote peers live:

| Role     | `SERVICES`                  | Remote endpoints                |
| -------- | --------------------------- | ------------------------------- |
| monolith | unset / `*`                 | none (all in-process)           |
| trips    | `trips.v1.TripService`      | `FLEET_ADDR`, `BILLING_ADDR`    |
| fleet    | `fleet.v1.FleetService`     | none (leaf)                     |
| billing  | `billing.v1.BillingService` | none (leaf)                     |

See `src/topology.ts` (env → `enabledServices` + `perServiceEnvResolver`).

## Run locally (monolith)

This example uses the 1.0.0 service-catalog API (`defineService`, `ctx.call`).
Install with a plain `pnpm install` — the `@connectum/*` packages are published
on npm at 1.0.0 (this example's `package.json` pins `^1.0.0`).

```bash
pnpm install
pnpm buf:generate     # gen/ — message types + catalog.gen.ts (ctx.call typing)
pnpm typecheck
pnpm test             # in-process e2e: gateway auth, ctx.call, error paths
pnpm start            # monolith on :5000 (SERVICES unset)
```

The e2e suite runs the whole app in one process and asserts: the happy
`StartTrip` path (GetVehicle pre-check + workflow start returning `{ trip,
workflow_id }`), `FAILED_PRECONDITION` for an unavailable vehicle, `NOT_FOUND`
propagated from fleet, the gateway rejecting unauthenticated / invalid-token
requests while the public fleet service is reachable without a token
(`tests/e2e/e2e.test.ts`), and the full FleetService persistence surface —
`GetVehicle`, streaming `ListVehicles` with filter + cursor pagination,
`ReserveVehicle`/`ReleaseVehicle` — over a real gRPC client
(`tests/e2e/fleet.test.ts`). The saga itself (orchestration order +
compensations) is covered by `tests/workflow/` and `tests/activity/`.

## Persistence: FleetService + Drizzle + Postgres

FleetService is the vehicle **system of record**, backed by [Drizzle ORM](https://orm.drizzle.team)
over Postgres (the [`postgres`](https://github.com/porsager/postgres) / postgres.js
driver). The `vehicles` table (`src/db/schema.ts`) carries `id`, `model`,
`available`, a lifecycle `status` (`available` | `reserved` | `maintenance`),
`lat`/`lng`, and `updated_at`. The invariant the service keeps is
`available <=> status === "available"`.

The RPC surface demonstrates a realistic data-access layer:

- **`GetVehicle`** — point read; `NOT_FOUND` on an unknown id. Still returns
  `Vehicle.available`, which the trip handler's `ctx.call` depends on.
- **`ListVehicles`** — **server-streaming** complex query: a SQL
  `where`/`order by id`/`limit` with **cursor pagination** (the client re-sends
  the last streamed `Vehicle.id` as `page_token`), optionally filtered to
  available vehicles via `available_only`.
- **`ReserveVehicle`** — atomic `UPDATE … WHERE id=? AND available=true`;
  `FAILED_PRECONDITION` if already reserved / in maintenance, `NOT_FOUND` if
  unknown.
- **`ReleaseVehicle`** — returns a vehicle to the available pool;
  `FAILED_PRECONDITION` for a maintenance vehicle, `NOT_FOUND` if unknown.

### Dependency injection — why the tests need no Docker

`buildServer({ db })` injects the database into `createFleetService(db)`. In
production that `db` is a postgres.js client over `DATABASE_URL`; the **e2e tests
inject a [PGlite](https://pglite.dev) in-process Postgres** through the same
parameter — Postgres compiled to WASM, no container required. `src/db/schema.ts`
is the schema source of truth; `pnpm db:generate` derives versioned SQL into
`drizzle/`. Both the docker-compose flow (`pnpm db:migrate`) and the PGlite test
migrator apply those **same** generated migrations, then seed the shared fleet
(`src/db/seed.ts`) — so the persistence e2e is fully real but self-contained.

### Run with Postgres (docker-compose)

The repo ships a `docker-compose.yml` with a Postgres service (healthcheck) and
the app wired via `DATABASE_URL`:

```bash
docker compose up -d postgres            # start Postgres only

# Apply migrations and seed the fleet (DATABASE_URL points at the compose Postgres):
export DATABASE_URL=postgresql://car_sharing:car_sharing@localhost:5432/car_sharing
pnpm db:migrate                          # apply drizzle/ migrations → vehicles table
pnpm db:seed                             # seed the demo fleet

docker compose up app                    # monolith on :5000 against Postgres
```

Schema/migration scripts:

| Command           | Purpose                                                              |
| ----------------- | ------------------------------------------------------------------- |
| `pnpm db:generate`| Generate versioned SQL migrations from `src/db/schema.ts` → `drizzle/` |
| `pnpm db:migrate` | Apply the `drizzle/` migrations to the Postgres at `DATABASE_URL` (same files the test migrator applies) |
| `pnpm db:push`    | Dev convenience: diff-sync `schema.ts` to the DB without migrations  |
| `pnpm db:seed`    | Seed the demo fleet (drops + inserts `src/db/seed.ts`)              |

> `pnpm start` / `pnpm dev` now require `DATABASE_URL` (FleetService opens its
> connection lazily on the first query). The e2e tests do **not** — they inject
> PGlite.

### `ctx.call` error propagation

When a `ctx.call` to an internal service throws (e.g. fleet's `NOT_FOUND`), the
`ConnectError` travels back through the trip handler and out to the external
gRPC client with its `Code` intact — the e2e asserts exactly this over the gRPC
loopback. The framework strips the in-process transport's framing headers
(`content-length` / `content-type`) from the propagated error, so they never
leak into the outer call's gRPC trailers (which would otherwise be illegal
HTTP/2). No edge-level error translation is needed.

## Phase 2 — durable saga with Temporal

Phase 1's `StartTrip` did the whole flow inline with `ctx.call`: check the
vehicle, open the tab, return. That is fine until a step **midway** fails — there
is no durable record of what already happened and nothing to undo it. Phase 2
replaces the inline chain with a **durable [Temporal](https://temporal.io)
workflow** that owns the trip lifecycle and **compensates automatically** when a
step fails. Connectum stays a thin RPC/contract layer; Temporal is the durable
brain.

### What moved

`StartTrip` keeps a **synchronous availability pre-check** (a `ctx.call` to
`FleetService/GetVehicle`) so the **edge error contract is unchanged**: an
unavailable vehicle is still `FAILED_PRECONDITION`, an unknown one still
`NOT_FOUND` — both raised **before** any workflow starts. Only after the
pre-check passes does the handler **start** the durable `TripWorkflow` and return
immediately with the trip id, an initial `STARTED` status, and the `workflow_id`:

```jsonc
// StartTrip response (the saga then runs durably in the background)
{ "trip": { "id": "trip-…", "status": "STARTED" }, "workflowId": "trip-…" }
```

Live status is read with a new **`GetTrip`** RPC, which issues a Temporal
**Workflow Query** (`handle.query(getTripStatus)`) against the running workflow,
falling back to a terminal status (`SETTLED` / `CANCELLED`) once it closes.

### The saga and its compensations

`TripWorkflow` runs the forward steps in order, registering each step's
compensation on a stack — **before** the forward call when the compensation's
inputs are already known (so an ambiguous failure that committed the side effect
is still unwound), or **after** when the compensation needs the call's result
(step 6's `refundCharge` needs the charge id). On **any** failure it unwinds the
stack in reverse (LIFO) and rethrows — the canonical Temporal saga pattern. Each
step is an **activity** that makes one ConnectRPC call to a role service.

| #   | Forward step (activity → RPC)            | Compensation (activity → RPC)             |
| --- | ---------------------------------------- | ----------------------------------------- |
| 1   | `reserveVehicle` → `FleetService/ReserveVehicle` | `releaseVehicle` → `FleetService/ReleaseVehicle` |
| 2   | `recordTrip` → `TripService/RecordTrip`  | `markTripCancelled` → `TripService/EndTrip` (CANCELLED) |
| 3   | _the drive_ (a workflow timer)           | —                                         |
| 4   | `endTrip` → `TripService/EndTrip` (ENDED) | _(none — rollback reuses step 2)_         |
| 5   | `openTab` → `BillingService/OpenTab`     | `voidTab` → `BillingService/VoidTab`      |
| 6   | `addCharge` → `BillingService/AddCharge` | `refundCharge` → `BillingService/RefundCharge` |
| 7   | `settle` → `BillingService/Settle`       | _(terminal — none)_                       |

So if **settle** fails, the unwind runs `refundCharge → voidTab →
markTripCancelled → releaseVehicle`; if **endTrip** fails (before any billing),
it runs only `markTripCancelled → releaseVehicle`. Every compensation is
**idempotent** (release on a free vehicle, void on a void tab, refund on a
refunded charge are all no-op successes), because Temporal may run a compensation
after a forward step partially applied. Step 1's availability failure is a
**non-retryable** `ApplicationFailure`, so the workflow fails fast with nothing
to undo.

Forward steps are made **idempotent under at-least-once retries** the same way:
`reserveVehicle` carries the trip id as a `holder_id`, so a Temporal retry that
re-runs the activity after its first attempt already committed the reservation
re-reserves *its own* vehicle (success) instead of being mistaken for a
double-booking — while a different trip on a held vehicle is still rejected.

### Processes

The native Temporal worker (the Rust core-bridge addon + the on-the-fly workflow
bundler) is **confined to one new process**, so the existing RPC roles keep their
no-build, native-TS run model:

| Process                | Entry              | Temporal package        |
| ---------------------- | ------------------ | ----------------------- |
| RPC roles (trips/fleet/billing/monolith) | `node src/index.ts` | `@temporalio/client` (pure JS) — gateway only |
| **Worker** (hosts the workflow + activities) | `node src/worker.ts` (`pnpm worker`) | `@temporalio/worker` (native) |

The gateway's Temporal client is **lazy** (`Connection.lazy` — no socket until
the first start/query), so the server starts and the **pre-check error paths run
without a live Temporal server**. Internal `RecordTrip` / `EndTrip` are
method-level `public` in proto so the worker's tokenless ConnectRPC clients pass
the gateway auth chain (fleet/billing are already service-level `public`).

### Run it and watch the saga

```bash
docker compose up -d postgres
DATABASE_URL=postgresql://car_sharing:car_sharing@localhost:5432/car_sharing pnpm db:migrate
DATABASE_URL=postgresql://car_sharing:car_sharing@localhost:5432/car_sharing pnpm db:seed
docker compose --profile saga up --build   # roles + worker + Temporal + Web UI
open http://localhost:8088                  # Temporal Web UI
```

Start a trip against the `trips` role (gRPC `:5002`) and watch `TripWorkflow`
walk reserve → record → end → openTab → addCharge → settle in the Web UI. Stop
the `billing` role mid-run to watch the compensations unwind in reverse.

### Tests — dockerless

The saga is covered without Docker or a Temporal cluster:

- `tests/workflow/tripWorkflow.test.ts` — the **real workflow** with **mocked
  activities** on Temporal's time-skipping test environment (an embedded test
  server; the binary is downloaded and cached on first run only). It asserts the
  forward order on success and the **reverse compensation order** on a `settle`
  failure and an `endTrip` failure.
- `tests/activity/activities.test.ts` — the **real activity bodies** (via
  `MockActivityEnvironment`) against an **in-process Connectum monolith**
  (`buildServer({ port: 0 })`, PGlite fleet), asserting the activity↔RPC wiring,
  the moved billing side effects, and compensation **idempotency**.
- `tests/e2e/e2e.test.ts` — the gateway with a **stub** Temporal client: the
  pre-check `FAILED_PRECONDITION` / `NOT_FOUND` paths, the Phase-4 RS256/JWKS auth
  paths (valid, missing, malformed, **wrong-issuer**, **wrong-audience**,
  **expired** → `UNAUTHENTICATED`), and that a valid `StartTrip` returns
  `{ trip, workflow_id }` and starts exactly one workflow keyed by the trip id.
  The RS256 tokens are minted against an **in-process JWKS server**
  (`tests/helpers/jwks.ts`) so the production `createRemoteJWKSet` validation
  branch is exercised — see [Phase 4](#phase-4--ory-as-the-idp).

## Phase 4 — Ory as the IdP

Phases 1–2 used a hand-rolled HS256 shared-secret JWT: the gateway both *minted*
(in tests) and *verified* tokens with one secret. That couples the app to identity
concerns it shouldn't own. Phase 4 makes Connectum a **thin identity CONSUMER**:
[Ory](https://www.ory.sh) Kratos owns users and sessions, Ory Oathkeeper validates
a session at the edge and **mints an RS256 JWT**, and the `trips` gateway only
**verifies** that JWT against Oathkeeper's published **JWKS**. No identity logic
enters `@connectum/*` — swap the JWKS endpoint and the whole IdP is replaceable.

```
Browser ──login──▶ Kratos (4433)                       # owns users + sessions
   │  ory_kratos_session cookie
   │  POST /trips.v1.TripService/StartTrip (cookie)
   ▼
Oathkeeper proxy (4455)
   │  cookie_session → Kratos /sessions/whoami          # validate session
   │  id_token mutator → MINT RS256 JWT (iss=issuer_url)# project sub/name/roles/aud
   ▼  Authorization: Bearer <RS256 JWT>   (Connect/HTTP1)
trips gateway (5000)
   │  createJwtAuthInterceptor({ jwksUri })             # createRemoteJWKSet branch
   │     verify signature (kid→JWK), iss, aud, exp
   │  createProtoAuthzInterceptor({ defaultPolicy: deny })
   ▼  internal gRPC ctx.call (tokenless, `public`)
fleet / billing
```

### The JWT contract

The `id_token` mutator projects the Kratos identity to **top-level** claims, so
the gateway's `claimsMapping` reads them directly (`src/auth.ts`):

| Claim   | Minted by Oathkeeper from        | Verified / used by trips                |
| ------- | -------------------------------- | --------------------------------------- |
| `sub`   | Kratos identity id               | `AuthContext.subject` (required)        |
| `iss`   | `issuer_url`                     | interceptor `issuer` check (`JWT_ISSUER`) |
| `aud`   | `claims.aud`                     | interceptor `audience` check (`JWT_AUDIENCE`) |
| `name`  | `identity.traits.email`          | `claimsMapping.name`                    |
| `roles` | `identity.traits.roles` (array)  | `claimsMapping.roles` → per-method authz |
| `exp`   | `ttl`                            | jose expiry                             |

`JWT_ISSUER` (`src/auth.ts`) is the **single source of truth** for `iss`, shared
by the interceptor, the Oathkeeper `issuer_url`, and the test mint. The gateway
consumes the public JWKS at `OATHKEEPER_JWKS_URI`
(`http://oathkeeper:4456/.well-known/jwks.json` in compose).

### Run it

```bash
docker compose --profile ory up --build
open http://localhost:4458        # Kratos self-service UI — register a rider, log in
```

Registering produces an `ory_kratos_session` cookie; call the edge through
Oathkeeper (`:4455`) with that cookie. The edge is **Connect over HTTP/1.1** (the
Oathkeeper standalone proxy is HTTP, not trailer-aware gRPC for a Node upstream),
so demo it with `curl` — **not `grpcurl`** (which speaks gRPC/HTTP2; keep it for
direct-to-trips):

```bash
curl -i http://localhost:4455/trips.v1.TripService/GetTrip \
  -H 'Content-Type: application/json' \
  -b 'ory_kratos_session=<cookie>' \
  -d '{"tripId":"trip-demo"}'
```

The one runtime change this requires is the env-gated `ALLOW_HTTP1=true` on the
trips role (the compose `ory` profile sets it). On a plaintext listener
`@connectum/core` serves **either** h2c gRPC **or** HTTP/1.1, not both, so the
default stays `false` (h2c) for the gRPC e2e, internal `ctx.call` hops, and
k8s/istio.

### Role-gating extension point

The minimal phase is **role-agnostic**: `roles` flow end-to-end but `TripService`
stays `default_policy: "allow"`, so a valid JWT suffices. To gate a future admin
RPC by role — **without touching the token pipeline** — add to the proto:

```proto
rpc AdminRecallVehicle(...) returns (...) {
  option (connectum.auth.v1.method_auth) = { requires { roles: ["fleet_admin"] } };
}
```

The `roles` claim already reaches `AuthContext.roles`, which the proto authz
interceptor reads.

### Production (k8s / istio): Oathkeeper as ext_authz

The `k8s/` + `istio/` manifests are **unchanged**. In the mesh, Envoy terminates
gRPC and Oathkeeper runs as an Istio **`ext_authz` decision service**: it
validates the session and the minted JWT is injected upstream, which trips still
JWKS-validates. Because Envoy handles gRPC, trips keeps `allowHTTP1: false` (h2c)
there — `ALLOW_HTTP1=true` is a compose-edge concern only. The gateway therefore
needs **no signing secret** (the old `k8s/secret-jwt.yaml` was removed); only
`OATHKEEPER_JWKS_URI` / `JWT_ISSUER` / `JWT_AUDIENCE` in `k8s/configmap.yaml`. See
`ory/oathkeeper/README.md` for the full edge + ext_authz details.

## OpenAPI — the published contract reflects the authz

The proto is the single source of truth: the same `connectum.auth.v1` options that
the gateway **enforces** at runtime also drive the **published** OpenAPI contract,
so the two cannot drift. Generate it with:

```bash
pnpm openapi   # buf generate (base) → scripts/openapi-authz.ts (authz overlay)
```

Two steps, decoupled from the offline `pnpm buf:generate`:

1. **Base spec** — `buf.gen.openapi.yaml` runs
   [`protoc-gen-connect-openapi`](https://github.com/sudorandom/protoc-gen-connect-openapi)
   (buf remote plugin) → OpenAPI v3.1 for the Connect API under `openapi/`.
2. **Authz overlay** — `scripts/openapi-authz.ts` reads the `connectum.auth.v1`
   options via **`resolveMethodAuth`** (the *same* reader the runtime
   `createProtoAuthzInterceptor` uses) and injects, per operation:
   - a `bearerAuth` (JWT) `securityScheme`;
   - `security: [{ bearerAuth: [] }]` on methods that require auth (e.g.
     `StartTrip`, `GetTrip`);
   - `security: []` + `x-connectum-public: true` on `public` methods (e.g. the
     tokenless worker RPCs `EndTrip` / `RecordTrip`, and all of fleet/billing);
   - `x-connectum-required-roles` / `-scopes` where the proto declares them.

The committed `openapi/*.yaml` is the showcase output — regenerate with
`pnpm openapi` after changing the proto or its auth options.

> **Notes.** Streaming RPCs (`ListVehicles`) are omitted from the base spec
> unless the plugin's `with-streaming` opt is set. The overlay targets the
> `@connectum/auth` 1.0.0 API this example pins. `@connectum/auth` 1.1.0 adds an
> `internal` method marker that the resolver exposes as `x-internal: true`;
> migrating this example onto that marker is tracked in
> [examples#36](https://github.com/Connectum-Framework/examples/issues/36).

## Phase 3 — EventBus broadcast (fan-out)

Phases 1 and 2 are about **driving** a flow: `ctx.call` is a synchronous request
that returns a value; the saga is a durable orchestration that retries and
compensates. Phase 3 adds the **third, orthogonal** mechanism — a
**fire-and-forget 1→N broadcast**. When a trip is **SETTLED**, the single domain
fact "this trip completed" is published **once** as `TripCompleted` and consumed
**independently** by three reactors that the saga knows nothing about.

| Mechanism            | Shape                              | Guarantee                                          |
| -------------------- | ---------------------------------- | -------------------------------------------------- |
| `ctx.call` (Phase 1) | synchronous typed RPC              | request/response                                   |
| Temporal saga (Phase 2) | durable orchestration + compensation | exactly-once, retried, **durable**              |
| **EventBus broadcast (Phase 3)** | **fire-and-forget 1→N**  | at-least-once per subscriber, **non-durable**, order-agnostic |

### Broadcast, not orchestration

EventBus is used here for **broadcast only** — never to drive the trip. The
publisher emits one event to one topic; three **independent** subscriber buses,
each its **own consumer group**, each get their own copy:

```
                       status = SETTLED  (Phase 2 saga, unchanged)
                                 │
                                 ▼  NEW terminal activity (worker, full Node)
              acts.publishTripCompleted({ tripId, userId, vehicleId, durationMs })
                                 │  publisherBus.publish(TripCompletedSchema, …)  // NO {topic}
                                 │  topic resolved = "trips.completed"  (proto option via publishes)
                                 ▼
        ┌──────────────────── topic: trips.completed ────────────────────┐
        │                       (NATS JetStream)                         │
        └───────┬───────────────────────┬───────────────────────┬───────┘
                │ group=cs-pricing       │ group=cs-audit        │ group=cs-notify
                ▼ (own durable consumer) ▼ (own durable consumer)▼ (own durable consumer)
       ┌──────────────────┐     ┌─────────────────┐     ┌──────────────────┐
       │ PRICING/ANALYTICS │     │   AUDIT-LOG     │     │  NOTIFICATIONS   │
       │ trip count + revenue│   │ append 1 record │     │ "receipt sent"   │
       └──────────────────┘     └─────────────────┘     └──────────────────┘
            each reacts on its own, order-agnostic, failure-isolated
```

Two independent reasons this is **fan-out** and not load-balance:

1. **Framework-level** — two routes resolving to the same topic **cannot share
   one bus** (the EventBus throws a *duplicate-topic* error at `start()`), so the
   three reactors on `trips.completed` are **forced** onto three separate buses.
2. **Broker-level** — each bus uses a **distinct consumer group**, so NATS
   JetStream gives each its own **durable consumer** → every reactor receives
   every event. A **shared** group would load-balance (one reactor steals each
   event) = a queue, not a broadcast.

So the rule the example teaches: **N independent consumers ⇒ N buses, each its
own group** — never one bus with N handlers on the same topic.

### Topic from the proto option (no raw strings)

The topic is declared **once**, on the proto method, and used end-to-end with no
hand-passed topic string:

```proto
service TripEventHandlers {
  rpc OnTripCompleted(TripCompleted) returns (google.protobuf.Empty) {
    option (connectum.events.v1.event).topic = "trips.completed";
  }
}
```

The publisher bus lists this service in **`publishes`**, which populates its
publish-topic lookup from the proto option — so `publish(TripCompletedSchema, …)`
resolves `trips.completed` with **no `{topic}` argument**. (A pure publisher has
no subscriber `routes`, so without `publishes` the topic would silently fall back
to the message `typeName`.) Each reactor registers the **same** service via its
own bus's `routes`, subscribing to the same proto-resolved topic.

### Failure semantics — a lost broadcast must never reverse a paid trip

This is the crux of "EventBus is broadcast, Temporal is durability". The publish
is a **success-only tail** placed **outside** the saga's `try/catch`, reached
**only** when the trip is `SETTLED`, in its own `try/catch` that does **not**
rethrow:

```ts
try {
    …reserve → record → end → openTab → addCharge → settle…
    status = TripStatus.SETTLED;
} catch (err) {
    …run compensations LIFO…; status = TripStatus.CANCELLED; throw …;  // rethrows
}
// SUCCESS-ONLY TAIL — reached only when status === SETTLED:
try {
    await broadcast.publishTripCompleted({ tripId, userId, vehicleId, durationMs });
} catch (err) {
    log.warn("broadcast failed; trip stays SETTLED", { tripId });
}
return status;
```

Because this block is reached only on success and its `catch` does not rethrow, a
failed or timed-out broadcast **can never trigger compensation** on a settled,
paid trip. The reactors' work (an analytics tally, an audit line, a receipt) is
non-critical and reconstructable — losing one is acceptable; reversing a settled
financial trip is not. The compensation guard is this **structural placement**,
not the activity's retry count.

> **Rule:** if a side effect must be **durable / retried**, it belongs in
> **Temporal** (its own activity with a retry policy), **not** on the EventBus.
> Don't copy the swallow into a place that needs durability.

### Idempotent reactors

On a real broker the broadcast is **at-least-once**: a worker crash after publish
but before ack re-fires the reactors, and a redelivery would otherwise
double-count an analytics tally or send a second receipt. Each reactor therefore
**dedupes by `tripId`** in its in-memory store. This is the reason broadcast
reactors are written idempotent — broadcast trades durability for decoupling, and
idempotency absorbs the resulting redelivery.

### Processes and the dockerless test

Same "one image, role by env" story as the RPC roles: the worker hosts the
**publish-only** bus, and each reactor is `node src/reactor.ts` with a `REACTOR`
selector picking its route and group.

| Process            | Entry                              | Bus                                       |
| ------------------ | ---------------------------------- | ----------------------------------------- |
| Worker (publisher) | `node src/worker.ts`               | publish-only (`publishes: [TripEventHandlers]`) |
| `reactor-pricing`  | `REACTOR=pricing node src/reactor.ts` | route `OnTripCompleted`, group `cs-pricing` |
| `reactor-audit`    | `REACTOR=audit node src/reactor.ts`   | route `OnTripCompleted`, group `cs-audit`   |
| `reactor-notify`   | `REACTOR=notify node src/reactor.ts`  | route `OnTripCompleted`, group `cs-notify`  |

`tests/e2e/broadcast.test.ts` proves the fan-out **without a broker**: one shared
`MemoryAdapter()` feeds the publisher bus and all three reactor buses, the real
`publishTripCompleted` activity is driven through `MockActivityEnvironment`, and
all three reactors are asserted to fire — with the **full five-field
`TripCompleted` shape** verified field-by-field against the documented contract.
The workflow test additionally proves the broadcast runs **only** on the SETTLED
path (never on a compensated run) and that a **failed** broadcast leaves the trip
`SETTLED` with no compensation.

### Run it and watch the fan-out

```bash
docker compose up -d postgres
DATABASE_URL=postgresql://car_sharing:car_sharing@localhost:5432/car_sharing pnpm db:migrate
DATABASE_URL=postgresql://car_sharing:car_sharing@localhost:5432/car_sharing pnpm db:seed
docker compose --profile saga up --build   # roles + worker + Temporal + NATS + 3 reactors
```

Start a trip on the `trips` role (`:5002`); when the saga settles, all **three**
reactor logs each print their independent reaction to the one `trips.completed`
event. Stop one reactor and replay — the others still receive (broadcast, not
steal).

> **Version note.** This phase uses the `publishes` option on `createEventBus`,
> added after `@connectum/events@1.0.0`. Until events `>= 1.1.0` is published,
> the example typechecks and runs against the **local** packages (the repo's
> local-package test flow), not the published `1.0.0` — against `1.0.0` the topic
> would fall back to the message `typeName`. Run with the local packages while
> the option is unreleased.

## Build the image

```bash
pnpm buf:generate        # gen/ must exist — it is copied into the image
pnpm run docker:build    # docker build -t car-sharing:local .
```

The Dockerfile is multi-stage and role-agnostic: `node src/index.ts` is the
entrypoint for every role (engines.node `>=25.2.0` runs TypeScript natively).
No lockfile is committed for this example; the `deps` stage runs `pnpm install`,
which resolves `@connectum/*` to the published 1.0.0 versions pinned in
`package.json` and generates the lockfile inside the image.

## Deploy to Kubernetes + Istio

> Config only — these manifests are not exercised by the automated test run; the
> e2e verifies the service code in-process. Adjust the image reference and the TLS
> `credentialName` before applying. Since Phase 4 the gateway holds **no signing
> secret** — identity is an RS256 JWT minted by Ory Oathkeeper (ext_authz) and
> validated against its JWKS, configured via `k8s/configmap.yaml`
> (`OATHKEEPER_JWKS_URI` / `JWT_ISSUER` / `JWT_AUDIENCE`); see
> [Phase 4](#phase-4--ory-as-the-idp) and `ory/oathkeeper/README.md`.

```bash
# 1. Namespace (with Istio sidecar injection) + identities + config.
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/configmap.yaml       # incl. OATHKEEPER_JWKS_URI / JWT_ISSUER / JWT_AUDIENCE

# 2. Workloads + Services + autoscaling.
kubectl apply -f k8s/deployment-fleet.yaml
kubectl apply -f k8s/deployment-billing.yaml
kubectl apply -f k8s/deployment-trips.yaml
kubectl apply -f k8s/services.yaml
kubectl apply -f k8s/hpa.yaml

# 3. Mesh security + routing.
kubectl apply -f istio/peer-authentication.yaml   # mTLS STRICT
kubectl apply -f istio/authorization-policy.yaml  # fleet/billing <- trips SA only
kubectl apply -f istio/destination-rule.yaml      # pools, outlier detection, subsets
kubectl apply -f istio/virtual-service.yaml       # in-mesh routing + retries
kubectl apply -f istio/gateway.yaml               # external ingress -> trips
```

### What each manifest wires

| File                                | Purpose                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `k8s/namespace.yaml`                | namespace + `istio-injection: enabled`                                  |
| `k8s/rbac.yaml`                     | one ServiceAccount per role (identities for AuthorizationPolicy)        |
| `k8s/configmap.yaml`                | per-role `SERVICES`, `*_ADDR`, `OTEL_*`, and the gateway's `OATHKEEPER_JWKS_URI` / `JWT_ISSUER` / `JWT_AUDIENCE` |
| `k8s/deployment-*.yaml`             | Deployment per role (probes, security context, graceful shutdown)       |
| `k8s/services.yaml`                 | ClusterIP Services; their DNS names are the `*_ADDR` targets            |
| `k8s/hpa.yaml`                      | HorizontalPodAutoscaler per role                                        |
| `istio/peer-authentication.yaml`    | mesh-wide mTLS STRICT                                                    |
| `istio/authorization-policy.yaml`   | fleet/billing admit only the trips SA; trips admits only ingress        |
| `istio/destination-rule.yaml`       | connection pools, outlier detection, `stable`/`canary` subsets          |
| `istio/virtual-service.yaml`        | in-mesh routing + retries for `ctx.call` traffic                        |
| `istio/gateway.yaml`                | external ingress Gateway + VirtualService → trips                       |
| `istio/canary-virtual-service.yaml` | 90/10 canary example for the fleet service                              |

### Canary rollout (example)

Deploy a second fleet Deployment whose pods carry `version: canary`, then shift
in-mesh traffic with the weighted route:

```bash
kubectl apply -f istio/canary-virtual-service.yaml   # 90% stable / 10% canary
# adjust weights to progress; re-apply istio/virtual-service.yaml to roll back
```

### Observability

Every role sets `OTEL_EXPORTER_OTLP_ENDPOINT` in its ConfigMap, which turns on the
`@connectum/otel` server interceptor (the app enables OTel only when that env var
is present — see `src/observability.ts`). Spans carry a `connectum.transport`
attribute distinguishing in-process `ctx.call`s from network hops, and
`trustRemote: true` stitches gateway → fleet (and worker → fleet/trips/billing activities) into one distributed trace.
Point `OTEL_EXPORTER_OTLP_ENDPOINT` at your Collector (the manifests assume
`otel-collector.observability.svc.cluster.local:4317`).

## Layout

```
car-sharing/
├── proto/                      fleet, trips, billing protos + trips/v1/trip_events.proto (TripCompleted + topic option)
├── src/
│   ├── db/                     Drizzle: schema.ts, client.ts (Db DI), seed.ts
│   ├── events/                 eventBus.ts (publisher + reactor bus factories), reactors.ts (3 idempotent reactors)
│   ├── services/               fleetService (Drizzle), billingService, tripService
│   ├── temporal/               TripWorkflow (+ broadcast tail), activities (+ publishTripCompleted), workflowClient, clients, config, tripStatus
│   ├── topology.ts             env → mono/split (SERVICES + perServiceEnvResolver)
│   ├── auth.ts                 RS256 JWT (JWKS) + proto authz interceptors (uniform chain)
│   ├── observability.ts        env-gated OpenTelemetry wiring
│   ├── server.ts               buildServer() — services + catalog + interceptors + db
│   ├── worker.ts               Temporal worker process (bundles workflow via swc; builds the publish-only bus; `pnpm worker`)
│   ├── reactor.ts              broadcast subscriber process (role by REACTOR=pricing|audit|notify)
│   └── index.ts                entry point (role by SERVICES)
├── drizzle/                    generated SQL migrations (single source of truth)
├── drizzle.config.ts           drizzle-kit config (schema → migrations / push)
├── ory/                        Phase 4 IdP config (config-only, like k8s/istio):
│                               kratos/ (identity provider) + oathkeeper/ (edge proxy)
├── tests/
│   ├── helpers/db.ts           PGlite test db (migrate + seed), injected via DI
│   ├── helpers/jwks.ts         RS256 keypair + in-process JWKS server + token mint (Phase 4)
│   ├── workflow/               TripWorkflow: forward order + reverse compensation + broadcast tail (mocked activities)
│   ├── activity/               Activity bodies: RPC wiring + compensation idempotency (in-process monolith)
│   └── e2e/                    e2e.test.ts (gateway/pre-check/auth, stub workflow client) + fleet.test.ts (persistence) + broadcast.test.ts (fan-out, MemoryAdapter)
├── k8s/                        namespace, rbac, configmap, deployments,
│                               services, hpa (gateway JWKS env, no signing secret)
├── istio/                      peer-auth, authz, destination-rule, virtual-service,
│                               gateway, canary
├── docker-compose.yml          profiles: `mono` (monolith + Postgres), `saga` (roles + worker + Temporal + Postgres + NATS + 3 reactors), `ory` (Kratos + Oathkeeper edge)
├── Dockerfile                  one multi-stage image, role by env
├── buf.yaml / buf.gen.yaml     multi-module (own protos + auth + events options) + catalog plugin
├── package.json / tsconfig.json / pnpm-workspace.yaml
```
