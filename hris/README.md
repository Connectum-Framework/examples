# hris

A shallow **HR Information System** that showcases the hard cases Connectum
solves out of the box: **the same handler code runs as a monolith (in-process)
or as microservices (split processes) purely by env**, plus an event-driven
payroll flow and a **durable Temporal saga** for onboarding.

It demonstrates **three orthogonal cross-service mechanisms** side by side, each
the right tool for a different job:

| Mechanism | Used for | In this example |
|---|---|---|
| **`ctx.call`** (synchronous) | a reply you need now | `RequestLeave` validates the employee against the directory |
| **EventBus** (fire-and-forget) | broadcast a fact | `LeaveApproved` → payroll decrements the balance |
| **Temporal saga** (durable) | a long multi-step transaction with rollback | onboarding a new hire across four services |

Five services, one integration event, and a durable saga:

- **`directory.v1.DirectoryService`** — `GetEmployee(id)` → `Employee` and
  `ListEmployees(filter)` → stream of `Employee` (the employee **system of
  record**, backed by Drizzle ORM + Postgres; `Code.NotFound` for an unknown id).
  Also hosts the saga's `CreateEmployee` / `ActivateEmployee` / `OffboardEmployee`.
  See [Persistence](#persistence-directoryservice--drizzle--postgres).
- **`timeoff.v1.TimeOffService`** — `RequestLeave(employeeId, days)`. Its handler
  validates the employee with
  `ctx.call("directory.v1.DirectoryService/GetEmployee", …)`, then approves and
  **publishes** a `LeaveApproved` event. Also hosts the saga's `GrantTimeOff` /
  `RevokeTimeOff`.
- **`payroll.v1.PayrollService`** — `GetBalance(employeeId)` → `Balance`.
  **Subscribes** to `LeaveApproved` and decrements the balance. Also hosts the
  saga's `SetupPayroll` / `TeardownPayroll`.
- **`access.v1.AccessService`** — `ProvisionAccess` / `RevokeAccess` (the saga's
  IT-provisioning leaf; an in-memory account ledger).
- **`onboarding.v1.OnboardingService`** — `OnboardEmployee` / `GetOnboarding`
  (the saga **gateway**: a synchronous pre-check, then it starts the durable
  `OnboardingWorkflow`). See [The onboarding saga](#the-onboarding-saga-temporal).

The product is deliberately thin — the point is the framework wiring.

> **Note:** this example uses the service-catalog API (`defineService`,
> `ctx.call`, `catalog`) and the EventBus, shipped in **1.0.0** (published on
> npm). The onboarding saga uses [Temporal](https://temporal.io) (an external
> dependency) — no Connectum API beyond 1.0.0, so it runs on the published
> packages.

## The headline: one codebase, two topologies

`src/server.ts` exposes a single `buildServer()`. It always passes the same five
service definitions and the same generated `serviceCatalog`. Only `src/topology.ts`
reads env and tells the framework what is local vs remote:

- **`SERVICES`** (parsed with `parseServicesEnv` → `enabledServices`) lists the
  proto `typeName`s mounted **locally**. Unset or `*` = **monolith** (all local).
  Set it to one service (`SERVICES=directory.v1.DirectoryService`) and the process
  becomes that single microservice role.
- **`remoteResolver: perServiceEnvResolver(…)`** maps each non-local service to an
  endpoint env var (`DIRECTORY_ADDR`, `TIMEOFF_ADDR`, `PAYROLL_ADDR`,
  `ACCESS_ADDR`, `ONBOARDING_ADDR`), so `ctx.call` auto-routes to the right
  process when it is remote.

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

## The onboarding saga (Temporal)

Onboarding a new hire is a **long, multi-step transaction**: create the directory
record, enrol them in payroll, grant their PTO policy, and provision system
access. If any step fails, the ones that already succeeded must be **undone** —
the classic *saga* with compensations. `ctx.call` and the EventBus are the wrong
tools (no durability, no rollback); this is where a durable workflow engine earns
its place. Connectum stays thin: the framework serves the RPCs; [Temporal](https://temporal.io)
owns the durability.

`OnboardingService.OnboardEmployee` is the **gateway**. It runs a **synchronous
pre-check** — `ctx.call` to the directory, where an *existing* id is rejected
with `Code.AlreadyExists` (the check is inverted from a "must exist" lookup: the
new id must be **free**). Only after the pre-check passes does it **start** the
durable `OnboardingWorkflow` and return immediately with `STARTED`. Because the
pre-check runs first, the error path needs **no live Temporal**.

The workflow runs the forward steps and pushes each step's compensation onto a
stack; on any failure it unwinds the stack in **LIFO** order, then fails:

```
createEmployee ──▶ setupPayroll ──▶ grantTimeOff ──▶ provisionAccess ──▶ activateEmployee  ✓ COMPLETED
   │ offboard        │ teardown        │ revokeTimeOff   │ revokeAccess        (terminal — no undo)
   └────────────── on failure, compensations run in reverse ◀──────────────┘  ✗ FAILED
```

- **`createEmployee`** is the saga's first step; a duplicate id is a **business**
  failure surfaced as `Code.AlreadyExists` (via an atomic
  `insert … on conflict do nothing returning`, never a raw DB error). The activity
  rethrows it as a **non-retryable** `ApplicationFailure` so the workflow fails
  fast with nothing to compensate.
- Every other step keeps Temporal's **default retry policy** — the durability the
  saga demonstrates. The compensations are **idempotent**, so an unwind after a
  partially-applied step is safe.
- **`activateEmployee`** (onboarding → active) is terminal: a success is final, so
  it pushes no compensation.

### The worker — a separate process

The durable code runs in a dedicated **worker** (`src/worker.ts`), the **only**
process that imports `@temporalio/worker` (the native core-bridge + the swc
workflow bundler). The RPC roles import only the pure-JS `@temporalio/client`, so
they keep their **no-build, native-TS** run model — `node src/index.ts`, no
compile step. The worker's activities drive the role services over ConnectRPC
(`*_ADDR`), exactly like any other cross-pod call.

### Run the saga

The `saga` compose profile adds Temporal, the onboarding gateway, and the worker;
it pairs with `split` (the worker targets the per-role services):

```bash
docker compose --profile split --profile saga up
# Onboard a new hire (the gateway is on :5005):
grpcurl -plaintext -d '{"employee_id":"e-100","name":"New Hire","email":"newhire@example.com","title":"Engineer","department":"Engineering","manager_id":"e-002"}' \
  localhost:5005 onboarding.v1.OnboardingService/OnboardEmployee
# Watch the workflow + its compensations in the Temporal Web UI:
open http://localhost:8088
```

## Layout

```
proto/
  directory/v1/directory.proto       # GetEmployee + ListEmployees + Create/Activate/Offboard (saga)
  timeoff/v1/timeoff.proto           # RequestLeave + GrantTimeOff/RevokeTimeOff (saga)
  payroll/v1/payroll.proto           # GetBalance + LeaveApproved + SetupPayroll/TeardownPayroll (saga)
  access/v1/access.proto             # AccessService.ProvisionAccess/RevokeAccess (saga leaf)
  onboarding/v1/onboarding.proto     # OnboardingService.OnboardEmployee/GetOnboarding (saga gateway)
  connectum/events/v1/options.proto  # (connectum.events.v1.event).topic option
buf.gen.yaml                         # protoc-gen-es + protoc-gen-connectum-catalog (strategy: all)
src/
  db/schema.ts                       # Drizzle: employees table + EmployeeStatus const
  db/client.ts                       # Db type + createDb() (DATABASE_URL, postgres.js)
  db/seed.ts                         # SEED_EMPLOYEES (org chart) + seedEmployees()
  services/directoryService.ts       # createDirectoryService(db) — leaf + saga create/activate/offboard
  services/timeOffService.ts         # ctx.call validation + publishes LeaveApproved + saga grant/revoke
  services/payrollService.ts         # GetBalance + LeaveApproved subscriber + saga setup/teardown
  services/accessService.ts          # AccessService — saga IT-provisioning leaf (in-memory)
  services/onboardingService.ts      # createOnboardingService(workflowClient) — saga gateway
  temporal/onboardingStatus.ts       # OnboardingStatus const (side-effect-free, sandbox-safe)
  temporal/config.ts                 # TEMPORAL_ADDRESS / NAMESPACE / TASK_QUEUE (env)
  temporal/workflowClient.ts         # lazy @temporalio/client WorkflowClient (gateway side)
  temporal/clients.ts                # ConnectRPC clients the activities drive (*_ADDR)
  temporal/activities.ts             # saga side effects (each one RPC) + compensations
  temporal/workflows.ts              # OnboardingWorkflow — the durable saga (deterministic sandbox)
  worker.ts                          # @temporalio/worker host (the ONLY native-addon process)
  topology.ts                        # env → enabledServices + remoteResolver
  events.ts                          # LEAVE_APPROVED_TOPIC constant (publisher/subscriber match)
  eventBus.ts                        # one bus per process; payroll subscribes only when local
  server.ts                          # buildServer() — same code, both topologies + db + Temporal DI
  index.ts                           # env-driven entry point
drizzle/                             # generated SQL migrations (single source of truth)
drizzle.config.ts                    # drizzle-kit config (schema → migrations / push)
gen/                                 # generated (buf): *_pb.ts + catalog.gen.ts
tests/
  helpers/db.ts                      # PGlite test db (migrate + seed), injected via DI
  e2e/e2e.test.ts                    # monolith e2e — in-process, no broker (PGlite db)
  e2e/directory.test.ts              # DirectoryService persistence e2e (real gRPC client)
  e2e/onboarding.test.ts             # onboarding edge — pre-check + start (stub Temporal)
  activity/activities.test.ts        # real activities ↔ RPC wiring + compensation idempotency
  workflow/onboardingWorkflow.test.ts# saga orchestration + LIFO compensation (time-skipping)
docker-compose.yml                   # mono + split + saga profiles (NATS + Postgres + Temporal)
Dockerfile                           # one image, role chosen by SERVICES env (worker = node src/worker.ts)
```

## The generated catalog

`buf generate` runs `protoc-gen-connectum-catalog` (`strategy: all`) to emit
`gen/catalog.gen.ts` with **all** services — including the event-handler service:

```ts
export const serviceCatalog = {
  "access.v1.AccessService": AccessService,
  "directory.v1.DirectoryService": DirectoryService,
  "onboarding.v1.OnboardingService": OnboardingService,
  "payroll.v1.PayrollService": PayrollService,
  "payroll.v1.PayrollEventHandlers": PayrollEventHandlers,
  "timeoff.v1.TimeOffService": TimeOffService,
} as const;

declare module "@connectum/core" {
  interface ConnectumCallMap {
    "access.v1.AccessService/ProvisionAccess": { request: ProvisionAccessRequest; response: ProvisionAccessResponse };
    "access.v1.AccessService/RevokeAccess": { request: RevokeAccessRequest; response: Empty };
    "directory.v1.DirectoryService/GetEmployee": { request: GetEmployeeRequest; response: GetEmployeeResponse };
    "directory.v1.DirectoryService/CreateEmployee": { request: CreateEmployeeRequest; response: CreateEmployeeResponse };
    "directory.v1.DirectoryService/ActivateEmployee": { request: ActivateEmployeeRequest; response: ActivateEmployeeResponse };
    "directory.v1.DirectoryService/OffboardEmployee": { request: OffboardEmployeeRequest; response: OffboardEmployeeResponse };
    "onboarding.v1.OnboardingService/OnboardEmployee": { request: OnboardEmployeeRequest; response: OnboardEmployeeResponse };
    "onboarding.v1.OnboardingService/GetOnboarding": { request: GetOnboardingRequest; response: GetOnboardingResponse };
    "payroll.v1.PayrollService/GetBalance": { request: GetBalanceRequest; response: GetBalanceResponse };
    "payroll.v1.PayrollService/SetupPayroll": { request: SetupPayrollRequest; response: SetupPayrollResponse };
    "payroll.v1.PayrollService/TeardownPayroll": { request: TeardownPayrollRequest; response: Empty };
    "payroll.v1.PayrollEventHandlers/OnLeaveApproved": { request: LeaveApproved; response: Empty };
    "timeoff.v1.TimeOffService/RequestLeave": { request: RequestLeaveRequest; response: RequestLeaveResponse };
    "timeoff.v1.TimeOffService/GrantTimeOff": { request: GrantTimeOffRequest; response: GrantTimeOffResponse };
    "timeoff.v1.TimeOffService/RevokeTimeOff": { request: RevokeTimeOffRequest; response: Empty };
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

pnpm build:proto   # buf generate → gen/ (incl. catalog.gen.ts with all services)
pnpm db:generate   # drizzle-kit → drizzle/ SQL migration (the PGlite test migrator applies it)
pnpm typecheck     # ctx.call is typed by the generated catalog
pnpm test          # e2e + workflow + activity tests (no Docker or Temporal server required)
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
docker compose --profile split up   # directory + timeoff + payroll + access + NATS
```

Or run roles directly (a NATS broker on `NATS_URL` is required for the event flow):

```bash
DATABASE_URL=postgresql://hris:hris@localhost:5432/hris PORT=5001 SERVICES=directory.v1.DirectoryService node src/index.ts
DATABASE_URL=postgresql://hris:hris@localhost:5432/hris PORT=5002 SERVICES=timeoff.v1.TimeOffService DIRECTORY_ADDR=http://localhost:5001 node src/index.ts
DATABASE_URL=postgresql://hris:hris@localhost:5432/hris PORT=5003 SERVICES=payroll.v1.PayrollService node src/index.ts
DATABASE_URL=postgresql://hris:hris@localhost:5432/hris PORT=5004 SERVICES=access.v1.AccessService node src/index.ts
```

## Testing note

The e2e suite runs the **monolith** with an in-memory EventBus adapter and a
PGlite (in-process Postgres) database injected via `buildServer({ db })` — no
Docker, no NATS, no Postgres container. Because the in-memory adapter delivers
synchronously, the `LeaveApproved` event has already decremented the payroll
balance by the time `RequestLeave` resolves, so the assertion needs no polling.
The cross-service validation path (`ctx.call` → `Code.NotFound` for an unknown
employee) needs no broker at all.

The e2e files share the same PGlite setup (`tests/helpers/db.ts`, which migrates
+ seeds the directory):

- `tests/e2e/e2e.test.ts` — the monolith flow (gateway `ctx.call` validation +
  event-driven balance decrement) over the injected db and bus.
- `tests/e2e/directory.test.ts` — the full DirectoryService persistence surface
  over a **real gRPC client**: `GetEmployee` (incl. `NOT_FOUND`), streaming
  `ListEmployees` with the `department` and org-chart `manager_id` filters, and
  cursor pagination.
- `tests/e2e/onboarding.test.ts` — the onboarding gateway: a free id passes the
  inverted pre-check and starts the saga (stub Temporal client); an already-taken
  id is rejected with `AlreadyExists` **before** Temporal; with no client the
  pre-check still runs and a free id then raises `Unavailable`.

The **saga itself** is verified without Docker or a Temporal cluster:

- `tests/workflow/onboardingWorkflow.test.ts` — the real `OnboardingWorkflow`
  with **mocked activities** under Temporal's **time-skipping** test environment:
  the forward order, and the **LIFO compensation** unwind on each failing step
  (incl. the non-retryable first step that compensates nothing).
- `tests/activity/activities.test.ts` — the **real activity bodies** against an
  in-process Connectum monolith (PGlite): each step mutates real service state,
  the duplicate-id failure is non-retryable, and every compensation is idempotent.

The split topology and the saga share this exact handler code and are exercised
via `docker-compose.yml` (the `split` and `saga` profiles).

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
- **Durable saga via Temporal** — onboarding is a multi-step transaction with
  automatic LIFO compensation, run in a dedicated **worker** process; the RPC
  roles stay no-build (only the worker loads the native `@temporalio/worker`).
  The framework serves the RPCs; Temporal owns the durability. Three mechanisms —
  `ctx.call`, EventBus, Temporal saga — coexist in one codebase, each fit to its
  job.
- **`enabledServices: undefined` vs `[]`** — monolith must pass `undefined`
  (mount everything); an empty array would mount nothing. `topology.ts` handles
  the unset/`*` → `undefined` mapping.
