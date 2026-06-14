# getting-started

The Connectum quickstart. One service, and almost no wiring — health checks,
reflection, the default interceptor chain and graceful shutdown all come from a
single `createServer` call.

> Uses the 1.0.0 API (`defineService`). Until it is published, install against
> local packages with `CONNECTUM_LOCAL=1` (see below).

## What it shows

- **`defineService`** — register a service; handlers receive `(request, ctx)`.
- **`createServer`** — explicit lifecycle (`start` / `ready` / `stop` events).
- **Health checks** — gRPC `grpc.health.v1.Health` + an HTTP `/healthz`
  endpoint (`@connectum/healthcheck`).
- **Server reflection** — `grpc.reflection.v1.ServerReflection`
  (`@connectum/reflection`), so `grpcurl` works without `.proto` files.
- **Default interceptors** — error handling + request validation
  (`@connectum/interceptors`).
- **Graceful shutdown** — on SIGTERM / SIGINT.

## Run it

Requires Node.js >= 25.2.0 (or Bun, or tsx) and pnpm >= 10.

```bash
CONNECTUM_LOCAL=1 pnpm install   # local packages until 1.0.0 is published
pnpm build:proto                 # buf generate → gen/
pnpm start                       # http://localhost:5000
pnpm test                        # e2e over a real gRPC client
```

Call it:

```bash
grpcurl -plaintext -d '{"name":"world"}' localhost:5000 greeter.v1.GreeterService/SayHello
# { "message": "Hello, world!" }
```

## Same code, three runtimes

The service is plain TypeScript — it runs unchanged on Node.js, Bun and tsx:

```bash
pnpm start          # Node.js (native type stripping)
pnpm start:bun      # Bun
pnpm start:tsx      # tsx (any Node.js 22+)
```

## Next

- [with-service-catalog](../with-service-catalog/) — cross-service calls with
  `ctx.call`.
- [Service Catalog guide](https://connectum.dev/en/guide/service-communication/service-catalog).
