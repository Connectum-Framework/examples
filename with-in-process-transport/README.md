# with-in-process-transport

Two ConnectRPC services (`OrdersService`, `InventoryService`) deployed inside a
**single Connectum server**, calling each other through the **in-process
transport** — no HTTP/2 loopback, no socket, no wire serialization.

## Why this pattern

When you split a system into multiple `*.proto` services for clean module
boundaries, you don't always want to pay the cost of an HTTP/2 hop to call
the service in the same process. The Connectum **local transport** lets you:

- Compose services as if they were libraries, but keep the `proto`-typed
  contract.
- Run the same handler code unchanged in two deployment modes:
  - **Modular monolith** — both services in one process (local transport).
  - **Distributed** — one service moves to another process (HTTP/2 transport
    via `options.fallback`).
- Reuse the entire server interceptor chain — auth, validation, OTEL,
  bulkhead, retry, timeout — exactly as for HTTP requests.
- Skip serialization for known callers (request/response objects flow
  in-memory; only `Headers` cross the boundary).

### When NOT to use it

- **Cross-process** calls (different deployments, different machines) —
  always use a real network transport.
- When you need wire-level features (TLS, custom HTTP middleware, raw
  framing) — those live on the HTTP/2 path only.

## API used

```ts
import { createServer } from "@connectum/core";
import { InventoryService } from "./gen/inventory/v1/inventory_pb.ts";

// Server registers BOTH services
const server = createServer({ services: [inventoryRoutes, ordersRoutes(server)] });

// Inside OrdersService.CreateOrder handler:
const inventory = server.client(InventoryService);
// - If InventoryService is registered locally → uses createLocalTransport
// - If not registered, falls back to `options.fallback` transport (e.g. gRPC)
const stock = await inventory.checkStock({ sku });
```

You can also obtain a strictly-local client (skip routing logic):

```ts
const inventory = server.localClient(InventoryService);
```

Or check registry membership:

```ts
if (server.hasService(InventoryService)) { /* local */ }
```

## Files

```
src/
├── server.ts                       # buildServer() — registers both services
├── services/inventoryService.ts    # stock map, CheckStock + Reserve handlers
├── services/ordersService.ts       # CreateOrder handler — calls server.client(InventoryService)
└── index.ts                        # demo entry point
proto/
├── inventory/v1/inventory.proto
└── orders/v1/orders.proto
bench/latency.ts                    # micro-benchmark (manual run)
tests/e2e/e2e.test.ts               # node:test e2e suite
```

## Run

```bash
# Generate proto bindings (first run only)
pnpm install
pnpm buf:generate

# Run the demo (Ctrl+C to stop)
pnpm start

# Run the e2e suite
pnpm test

# Run the latency benchmark (manual, not in CI)
pnpm bench
```

To test against your local working copy of `@connectum/*` packages instead
of the published npm versions:

```bash
# in the connectum/ workspace
pnpm run pack:all

# back here
CONNECTUM_LOCAL=1 pnpm install
pnpm test
```

## Latency benchmark

`pnpm bench` measures unary `InventoryService.CheckStock`:

- **local transport** — direct `createLocalTransport(server)` invoke.
- **HTTP/2 loopback** — `createGrpcTransport({ baseUrl: 'http://localhost:N' })`
  against the same server.

10 000 iterations after a 500-iter warmup; reports mean / p50 / p95 / p99 in
microseconds plus a `speedup_mean` ratio.

Sample run on a Node.js 25 dev box (small unary payload):

| transport         | p50      | p95      | p99      | mean     |
| ----------------- | -------- | -------- | -------- | -------- |
| local-transport   | ~51 µs   | ~89 µs   | ~136 µs  | ~68 µs   |
| http/2-loopback   | ~340 µs  | ~580 µs  | ~850 µs  | ~398 µs  |

≈ **5–6× speedup on mean latency**, even on loopback. Numbers are
machine-dependent — run `pnpm bench` locally for your hardware.

## See also

- Guide: [`docs/en/guide/production/in-process-transport.md`](../../docs/en/guide/production/in-process-transport.md) *(added in Phase 6)*
- Package: `@connectum/core` — `createLocalTransport`, `server.localClient`, `server.client`, `server.hasService`
