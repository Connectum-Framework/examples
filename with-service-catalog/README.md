# with-service-catalog

Declarative cross-service calls with the Connectum **service catalog**:
`defineService` + a buf-generated catalog + `ctx.call`.

`OrdersService.CreateOrder` fans out to `InventoryService` (`CheckStock`, then
`Reserve`) using `ctx.call("inventory.v1.InventoryService/CheckStock", ...)`.
Both services are mounted on one server, so the calls dispatch **in-process** —
no client, no transport, and (unlike the [in-process-transport](../with-in-process-transport/)
example) **no forward reference to the server**. Split `InventoryService` into
its own process and add a `remoteResolver`, and the same two `ctx.call` lines
keep working.

> **Note:** this example uses the service-catalog API (`defineService`,
> `ctx.call`, `catalog`), which ships in **1.0.0**. Until it is published, run it
> against local packages with `CONNECTUM_LOCAL=1` (see below).

## Layout

```
proto/
  orders/v1/orders.proto         # OrdersService.CreateOrder
  inventory/v1/inventory.proto   # InventoryService.CheckStock / Reserve
buf.gen.yaml                     # protoc-gen-es + protoc-gen-connectum-catalog
src/
  services/ordersService.ts      # defineService — uses ctx.call
  services/inventoryService.ts   # defineService — leaf service
  server.ts                      # createServer({ services, catalog })
  index.ts                       # demo: place one order
gen/                             # generated (buf): *_pb.ts + catalog.gen.ts
tests/e2e/e2e.test.ts
```

## The generated catalog

`buf generate` runs `protoc-gen-connectum-catalog` (with `strategy: all`) to emit
`gen/catalog.gen.ts`:

```ts
import type {} from "@connectum/core";
import { InventoryService } from "./inventory/v1/inventory_pb.ts";
import { OrdersService } from "./orders/v1/orders_pb.ts";

export const serviceCatalog = {
  "inventory.v1.InventoryService": InventoryService,
  "orders.v1.OrdersService": OrdersService,
} as const;

declare module "@connectum/core" {
  interface ConnectumCallMap {
    "inventory.v1.InventoryService/CheckStock": { request: CheckStockRequest; response: CheckStockResponse };
    "inventory.v1.InventoryService/Reserve": { request: ReserveRequest; response: ReserveResponse };
    "orders.v1.OrdersService/CreateOrder": { request: CreateOrderRequest; response: CreateOrderResponse };
  }
  interface ConnectumStreamMap {}
}
```

The runtime `serviceCatalog` is passed to `createServer({ catalog })`; the
`declare module` augmentation types every `ctx.call` key. `server.ts` imports
`serviceCatalog`, which loads the augmentation.

## Run it

Requires Node.js >= 25.2.0 (native TypeScript) and pnpm >= 10.

```bash
# This example uses the 1.0.0 service-catalog API. Until it is published,
# install against local @connectum/* tarballs (CONNECTUM_LOCAL — see the
# repository's development setup docs):
CONNECTUM_LOCAL=1 pnpm install

pnpm build:proto                    # buf generate → gen/ (incl. catalog.gen.ts)
pnpm start                          # starts the server + places a demo order
pnpm test                           # e2e: in-process + HTTP/2 loopback
```

When 1.0.0 is published, a plain `pnpm install` works (no `CONNECTUM_LOCAL`).

Expected demo output:

```
with-service-catalog ready on 127.0.0.1:5000
CreateOrder → order-widget-demo | reserved=true | remainingStock=8
```

## Key points

- **`defineService`** — handlers receive a Connectum `ctx` (the ConnectRPC
  `HandlerContext` plus `ctx.call` / `ctx.stream`).
- **`ctx.call("<typeName>/<Method>", req)`** — typed by the generated catalog;
  auto-routes local (in-process) vs remote (resolver); the inbound
  deadline/signal cascade automatically.
- **No wiring boilerplate** — no per-service transport, no `server.client()`
  plumbing, no forward reference to the server.
- **Same code, split deployment** — move `InventoryService` out and configure a
  `remoteResolver`; the handler does not change. See the
  [Service Catalog guide](https://connectum.dev/en/guide/service-communication/service-catalog).
