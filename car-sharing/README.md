# car-sharing — enterprise deployment on Kubernetes + Istio

A surface-level car-sharing app whose headline is **production deployment**: one
Connectum image runs as three microservices on Kubernetes behind an Istio mesh,
showing three things that are normally hard, wired straight from the framework:

- **Gateway auth at the edge** — JWT authentication + proto-driven authorization
  (`@connectum/auth`) on the public-facing `trips` service.
- **Cross-service `ctx.call` across split pods** — the trip handler calls fleet
  and billing through the typed service catalog; the framework picks in-process
  or network transport from env, no handler changes.
- **OpenTelemetry observability** — RPC tracing/metrics (`@connectum/otel`),
  enabled per role by env, on top of Istio's mesh telemetry.

The product is deliberately shallow. The value is the deployment + framework
wiring.

## Domain

| Service                   | Role            | RPC                          | Auth                                  |
| ------------------------- | --------------- | ---------------------------- | ------------------------------------- |
| `trips.v1.TripService`    | edge / gateway  | `StartTrip(userId, vehicle)` | JWT required (proto `default_policy: allow`) |
| `fleet.v1.FleetService`   | internal leaf   | `GetVehicle`, `ListVehicles` (stream), `ReserveVehicle`, `ReleaseVehicle` | `public` (proto `service_auth.public`) |
| `billing.v1.BillingService` | internal leaf | `OpenTab(tripId)`            | `public`                              |

`FleetService` is backed by a real database (Drizzle ORM + Postgres) — see
[Persistence](#persistence-fleetservice--drizzle--postgres). The trip/billing
services remain in-memory for now (later phases).

`StartTrip` orchestrates two cross-service calls:

1. `ctx.call("fleet.v1.FleetService/GetVehicle", …)` — unavailable vehicle →
   `FAILED_PRECONDITION`; unknown id → `NOT_FOUND` (propagated from fleet).
2. `ctx.call("billing.v1.BillingService/OpenTab", …)` — opens the tab once the
   trip starts.

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
    tripsApp -->|"ctx.call GetVehicle<br/>(FLEET_ADDR)"| fleetApp
    tripsApp -->|"ctx.call OpenTab<br/>(BILLING_ADDR)"| billingApp

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
`StartTrip` path (both `ctx.call`s), `FAILED_PRECONDITION` for an unavailable
vehicle, `NOT_FOUND` propagated from fleet, the gateway rejecting unauthenticated
/ invalid-token requests while the public fleet service is reachable without a
token (`tests/e2e/e2e.test.ts`), and the full FleetService persistence surface —
`GetVehicle`, streaming `ListVehicles` with filter + cursor pagination,
`ReserveVehicle`/`ReleaseVehicle` — over a real gRPC client
(`tests/e2e/fleet.test.ts`).

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
> e2e verifies the service code in-process. Adjust the image reference, the TLS
> `credentialName`, and `k8s/secret-jwt.yaml` before applying.

```bash
# 1. Namespace (with Istio sidecar injection) + identities + config.
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/secret-jwt.yaml      # replace JWT_SECRET first
kubectl apply -f k8s/configmap.yaml

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
| `k8s/secret-jwt.yaml`               | `JWT_SECRET` for the gateway (replace before use)                       |
| `k8s/configmap.yaml`                | per-role `SERVICES`, `*_ADDR`, and `OTEL_*` env                         |
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
`trustRemote: true` stitches gateway → fleet → billing into one distributed trace.
Point `OTEL_EXPORTER_OTLP_ENDPOINT` at your Collector (the manifests assume
`otel-collector.observability.svc.cluster.local:4317`).

## Layout

```
car-sharing/
├── proto/                      fleet, trips, billing protos (+ auth options import)
├── src/
│   ├── db/                     Drizzle: schema.ts, client.ts (Db DI), seed.ts
│   ├── services/               fleetService (Drizzle), billingService, tripService
│   ├── topology.ts             env → mono/split (SERVICES + perServiceEnvResolver)
│   ├── auth.ts                 JWT + proto authz interceptors (uniform chain)
│   ├── observability.ts        env-gated OpenTelemetry wiring
│   ├── server.ts               buildServer() — services + catalog + interceptors + db
│   └── index.ts                entry point (role by SERVICES)
├── drizzle/                    generated SQL migrations (single source of truth)
├── drizzle.config.ts           drizzle-kit config (schema → migrations / push)
├── tests/
│   ├── helpers/db.ts           PGlite test db (migrate + seed), injected via DI
│   └── e2e/                     e2e.test.ts (gateway/ctx.call) + fleet.test.ts (persistence)
├── k8s/                        namespace, rbac, secret, configmap, deployments,
│                               services, hpa
├── istio/                      peer-auth, authz, destination-rule, virtual-service,
│                               gateway, canary
├── docker-compose.yml          local monolith + Postgres (healthcheck)
├── Dockerfile                  one multi-stage image, role by env
├── buf.yaml / buf.gen.yaml     dual-module (own protos + auth options) + catalog plugin
├── package.json / tsconfig.json / pnpm-workspace.yaml
```
