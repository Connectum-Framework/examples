# hris

A shallow **HR Information System** that showcases the hard cases Connectum
solves out of the box: **the same handler code runs as a monolith (in-process)
or as microservices (split processes) purely by env**, plus an event-driven
payroll flow.

Three services and one integration event:

- **`directory.v1.DirectoryService`** — `GetEmployee(id)` → `Employee` and
  `ListEmployees(filter)` → stream of `Employee` (the employee **system of
  record**, backed by Drizzle ORM + Postgres; `Code.NotFound` for an unknown id).
  A leaf service — see [Persistence](#persistence-directoryservice--drizzle--postgres).
- **`timeoff.v1.TimeOffService`** — `RequestLeave(employeeId, days)`. Its handler
  validates the employee with
  `ctx.call("directory.v1.DirectoryService/GetEmployee", …)`, then approves and
  **publishes** a `LeaveApproved` event.
- **`payroll.v1.PayrollService`** — `GetBalance(employeeId)` → `Balance`.
  **Subscribes** to `LeaveApproved` and decrements the balance.

The product is deliberately thin — the point is the framework wiring.

> **Note:** this example uses the service-catalog API (`defineService`,
> `ctx.call`, `catalog`) and the EventBus, shipped in **1.0.0** (published on
> npm).

## The headline: one codebase, two topologies

`src/server.ts` exposes a single `buildServer()`. It always passes the same three
service definitions and the same generated `serviceCatalog`. Only `src/topology.ts`
reads env and tells the framework what is local vs remote:

- **`SERVICES`** (parsed with `parseServicesEnv` → `enabledServices`) lists the
  proto `typeName`s mounted **locally**. Unset or `*` = **monolith** (all local).
  Set it to one service (`SERVICES=directory.v1.DirectoryService`) and the process
  becomes that single microservice role.
- **`remoteResolver: perServiceEnvResolver(…)`** maps each non-local service to an
  endpoint env var (`DIRECTORY_ADDR`, `TIMEOFF_ADDR`, `PAYROLL_ADDR`), so
  `ctx.call` auto-routes to the right process when it is remote.

Nothing in the service handlers changes between topologies.

```mermaid
flowchart TB
  subgraph MONO["Monolith — SERVICES unset (one process)"]
    direction LR
    M_TO["TimeOffService"] -- "ctx.call (in-process)" --> M_DIR["DirectoryService"]
    M_TO -- "LeaveApproved" --> M_BUS(("EventBus<br/>(one bus)"))
    M_BUS -- "deliver" --> M_PAY["PayrollService<br/>subscriber"]
  end

  subgraph SPLIT["Microservices — SERVICES per role (three processes + NATS)"]
    direction LR
    S_TO["timeoff process<br/>TimeOffService"] -- "ctx.call → DIRECTORY_ADDR<br/>(gRPC over network)" --> S_DIR["directory process<br/>DirectoryService"]
    S_TO -- "publish LeaveApproved" --> NATS(("NATS"))
    NATS -- "deliver" --> S_PAY["payroll process<br/>PayrollService subscriber"]
  end
```

In the **monolith** the `ctx.call` dispatches in-process and the publisher and
subscriber share **one bus instance** (TimeOff publishes, Payroll subscribes,
within the same process). In the **split** topology the *same* `ctx.call` goes
over the network via the resolver, and `LeaveApproved` flows broker-to-broker to
the payroll role — without changing a line of handler code.

Both topologies use the **NATS** adapter at runtime (`NATS_URL`), so both need a
NATS broker when started via `pnpm start` / Docker. Only the e2e test swaps in an
in-memory adapter so the full flow runs broker-free (see
[Testing note](#testing-note)).

## Layout

```
proto/
  directory/v1/directory.proto       # DirectoryService.GetEmployee + ListEmployees (stream)
  timeoff/v1/timeoff.proto           # TimeOffService.RequestLeave
  payroll/v1/payroll.proto           # PayrollService.GetBalance + LeaveApproved + PayrollEventHandlers
  connectum/events/v1/options.proto  # (connectum.events.v1.event).topic option
buf.gen.yaml                         # protoc-gen-es + protoc-gen-connectum-catalog (strategy: all)
src/
  db/schema.ts                       # Drizzle: employees table + EmployeeStatus const
  db/client.ts                       # Db type + createDb() (DATABASE_URL, postgres.js)
  db/seed.ts                         # SEED_EMPLOYEES (org chart) + seedEmployees()
  services/directoryService.ts       # createDirectoryService(db) — Drizzle-backed leaf service
  services/timeOffService.ts         # ctx.call validation + publishes LeaveApproved
  services/payrollService.ts         # GetBalance + LeaveApproved subscriber route
  topology.ts                        # env → enabledServices + remoteResolver
  events.ts                          # LEAVE_APPROVED_TOPIC constant (publisher/subscriber match)
  eventBus.ts                        # one bus per process; payroll subscribes only when local
  server.ts                          # buildServer() — same code, both topologies + db DI
  index.ts                           # env-driven entry point
drizzle/                             # generated SQL migrations (single source of truth)
drizzle.config.ts                    # drizzle-kit config (schema → migrations / push)
gen/                                 # generated (buf): *_pb.ts + catalog.gen.ts
tests/
  helpers/db.ts                      # PGlite test db (migrate + seed), injected via DI
  e2e/e2e.test.ts                    # monolith e2e — in-process, no broker (PGlite db)
  e2e/directory.test.ts              # DirectoryService persistence e2e (real gRPC client)
docker-compose.yml                   # mono + split profiles + NATS + Postgres (config only)
Dockerfile                           # one image, role chosen by SERVICES env
```

## The generated catalog

`buf generate` runs `protoc-gen-connectum-catalog` (`strategy: all`) to emit
`gen/catalog.gen.ts` with **all** services — including the event-handler service:

```ts
export const serviceCatalog = {
  "directory.v1.DirectoryService": DirectoryService,
  "payroll.v1.PayrollService": PayrollService,
  "payroll.v1.PayrollEventHandlers": PayrollEventHandlers,
  "timeoff.v1.TimeOffService": TimeOffService,
} as const;

declare module "@connectum/core" {
  interface ConnectumCallMap {
    "directory.v1.DirectoryService/GetEmployee": { request: GetEmployeeRequest; response: GetEmployeeResponse };
    "payroll.v1.PayrollService/GetBalance": { request: GetBalanceRequest; response: GetBalanceResponse };
    "payroll.v1.PayrollEventHandlers/OnLeaveApproved": { request: LeaveApproved; response: Empty };
    "timeoff.v1.TimeOffService/RequestLeave": { request: RequestLeaveRequest; response: RequestLeaveResponse };
  }
  interface ConnectumStreamMap {
    "directory.v1.DirectoryService/ListEmployees": { request: ListEmployeesRequest; response: Employee; kind: "server-stream" };
  }
}
```

The runtime `serviceCatalog` is passed to `createServer({ catalog })`; the
`declare module` augmentation types every `ctx.call` key. The event-handler entry
(`PayrollEventHandlers`) is mounted via the EventBus, never as an RPC service, so
it is simply never resolved through `ctx.call`.

## Persistence: DirectoryService + Drizzle + Postgres

DirectoryService is the employee **system of record**, backed by [Drizzle ORM](https://orm.drizzle.team)
over Postgres (the [`postgres`](https://github.com/porsager/postgres) / postgres.js
driver). The `employees` table (`src/db/schema.ts`) carries `id`, `name`, `email`,
`title`, `department`, a self-referencing `manager_id` (nullable — empty for the
top of the org chart, e.g. the CEO), a lifecycle `status`
(`active` | `onboarding` | `offboarded`), and `updated_at`. The seed
(`src/db/seed.ts`) builds a small org chart across two departments — a CEO, two
managers, and four individual contributors — so the filters below are meaningful.

The RPC surface demonstrates a realistic data-access layer:

- **`GetEmployee`** — point read; `NOT_FOUND` on an unknown id. Returns the full
  `Employee` (incl. `manager_id` and `status`). This is the row the TimeOff
  handler's `ctx.call` reads to validate an employee before approving leave.
- **`ListEmployees`** — **server-streaming** complex query: a SQL
  `where`/`order by id`/`limit` with **cursor pagination** (the client re-sends
  the last streamed `Employee.id` as `page_token`), filterable by `department`
  and/or `manager_id`. The **`manager_id` filter is the org-chart "direct reports
  of this manager" query** — passing an employee id streams that person's direct
  reports; the two filters compose (e.g. "Engineering employees reporting to
  e-002").

The status domain is pinned in code by an `EmployeeStatus` `const` object (proto
models it as a plain string; a native proto enum is avoided under
`erasableSyntaxOnly` — see `directory.proto`). `manager_id` is a plain nullable
text column (no DB-level foreign key), keeping the migration simple.

### Dependency injection — why the tests need no Docker

`buildServer({ db })` injects the database into `createDirectoryService(db)`. In
production that `db` is a postgres.js client over `DATABASE_URL`; the **e2e tests
inject a [PGlite](https://pglite.dev) in-process Postgres** through the same
parameter — Postgres compiled to WASM, no container required. `src/db/schema.ts`
is the schema source of truth; `pnpm db:generate` derives versioned SQL into
`drizzle/`. Both the docker-compose flow (`pnpm db:migrate`) and the PGlite test
migrator apply those **same** generated migrations, then seed the shared directory
(`src/db/seed.ts`) — so the persistence e2e is fully real but self-contained.

### Run with Postgres (docker-compose)

The `docker-compose.yml` ships a Postgres service (healthcheck) alongside NATS,
with every app role wired via `DATABASE_URL`:

```bash
docker compose up -d postgres            # start Postgres only

# Apply migrations and seed the directory (DATABASE_URL points at the compose Postgres):
export DATABASE_URL=postgresql://hris:hris@localhost:5432/hris
pnpm db:migrate                          # apply drizzle/ migrations → employees table
pnpm db:seed                             # seed the demo org chart

docker compose --profile mono up         # monolith on :5000 against Postgres + NATS
```

Schema/migration scripts:

| Command           | Purpose                                                              |
| ----------------- | ------------------------------------------------------------------- |
| `pnpm db:generate`| Generate versioned SQL migrations from `src/db/schema.ts` → `drizzle/` |
| `pnpm db:migrate` | Apply the `drizzle/` migrations to the Postgres at `DATABASE_URL` (same files the test migrator applies) |
| `pnpm db:push`    | Dev convenience: diff-sync `schema.ts` to the DB without migrations  |
| `pnpm db:seed`    | Seed the demo org chart (drops + inserts `src/db/seed.ts`)          |

> `pnpm start` / `pnpm dev` now require `DATABASE_URL` (DirectoryService opens its
> connection lazily on the first query; every role constructs the client, but
> only the role mounting the directory ever queries). The e2e tests do **not** —
> they inject PGlite.

## Run it

Requires Node.js >= 25.2.0 (native TypeScript) and pnpm >= 10.

```bash
pnpm install

pnpm build:proto   # buf generate → gen/ (incl. catalog.gen.ts with all 3 services)
pnpm db:generate   # drizzle-kit → drizzle/ SQL migration (the PGlite test migrator applies it)
pnpm typecheck     # ctx.call is typed by the generated catalog
pnpm test          # e2e: ctx.call validation + event-driven balance decrement + directory persistence
```

The `drizzle/` migrations are committed and are the single source of truth: the
e2e PGlite db and `pnpm db:migrate` apply the exact same files, so a green test
run exercises the real schema. See
[Persistence](#persistence-directoryservice--drizzle--postgres) for Postgres.

### Monolith (one process, requires NATS)

`pnpm start` runs everything in one process (`SERVICES` unset). The bus uses the
NATS adapter, so a broker on `NATS_URL` is required at runtime. With Docker:

```bash
docker compose --profile mono up    # mono process + NATS
```

Or directly, against a running NATS broker:

```bash
DATABASE_URL=postgresql://hris:hris@localhost:5432/hris NATS_URL=nats://localhost:4222 pnpm start
```

### Microservices (split, requires NATS)

The same image runs each role; cross-service calls auto-route and `LeaveApproved`
flows over NATS. With Docker:

```bash
docker compose --profile split up   # directory + timeoff + payroll + NATS
```

Or run roles directly (a NATS broker on `NATS_URL` is required for the event flow):

```bash
DATABASE_URL=postgresql://hris:hris@localhost:5432/hris PORT=5001 SERVICES=directory.v1.DirectoryService node src/index.ts
DATABASE_URL=postgresql://hris:hris@localhost:5432/hris PORT=5002 SERVICES=timeoff.v1.TimeOffService DIRECTORY_ADDR=http://localhost:5001 node src/index.ts
DATABASE_URL=postgresql://hris:hris@localhost:5432/hris PORT=5003 SERVICES=payroll.v1.PayrollService node src/index.ts
```

## Testing note

The e2e suite runs the **monolith** with an in-memory EventBus adapter and a
PGlite (in-process Postgres) database injected via `buildServer({ db })` — no
Docker, no NATS, no Postgres container. Because the in-memory adapter delivers
synchronously, the `LeaveApproved` event has already decremented the payroll
balance by the time `RequestLeave` resolves, so the assertion needs no polling.
The cross-service validation path (`ctx.call` → `Code.NotFound` for an unknown
employee) needs no broker at all.

Two test files share the same PGlite setup (`tests/helpers/db.ts`, which migrates
+ seeds the directory):

- `tests/e2e/e2e.test.ts` — the monolith flow (gateway `ctx.call` validation +
  event-driven balance decrement) over the injected db and bus.
- `tests/e2e/directory.test.ts` — the full DirectoryService persistence surface
  over a **real gRPC client**: `GetEmployee` (incl. `NOT_FOUND`), streaming
  `ListEmployees` with the `department` and org-chart `manager_id` filters, and
  cursor pagination.

The split topology shares this exact handler code and is exercised via
`docker-compose.yml`.

## Key points

- **One `buildServer()`, two topologies** — `enabledServices` (from `SERVICES`)
  decides what is mounted locally; `remoteResolver` routes the rest. Handlers are
  identical in both.
- **`ctx.call("<typeName>/<Method>", req)`** — typed by the generated catalog;
  auto-routes in-process vs remote; the inbound deadline/signal cascade.
- **Event-driven across topologies** — TimeOff publishes `LeaveApproved`, Payroll
  subscribes. One bus instance in the monolith, one bus per process in the split
  deployment; both use the NATS adapter at runtime. The e2e swaps in an in-memory
  adapter to run the flow broker-free.
- **Persistence via DI** — DirectoryService is backed by Drizzle + Postgres,
  injected through `buildServer({ db })`. Production uses postgres.js over
  `DATABASE_URL`; tests inject PGlite so the persistence e2e runs without Docker.
  The committed `drizzle/` migrations are the single source of truth both paths
  apply.
- **`enabledServices: undefined` vs `[]`** — monolith must pass `undefined`
  (mount everything); an empty array would mount nothing. `topology.ts` handles
  the unset/`*` → `undefined` mapping.
