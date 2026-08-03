# getting-started

The Connectum quickstart. One service, and almost no wiring — health checks,
reflection, the default interceptor chain and graceful shutdown all come from a
single `createServer` call.

> Uses the 1.0.0 API (`defineService`). The published packages install with a
> plain `pnpm install`; use `CONNECTUM_LOCAL=1` only for local-package development (see below).

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
pnpm install                     # @connectum/*@^1.0.0 from npm (use CONNECTUM_LOCAL=1 only for local-package dev)
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
pnpm start:tsx      # tsx
```

## In a container

Two Dockerfiles, one per runtime. Both generate the proto code during the build (`gen/`
is not committed and `buf` is a devDependency), then ship production dependencies only:

```bash
docker build -t quickstart .                      # Node.js
docker build -f Dockerfile.bun -t quickstart .    # Bun

docker run --rm -p 5000:5000 quickstart
curl -fsS --http2-prior-knowledge http://localhost:5000/healthz
```

The probe needs `--http2-prior-knowledge` because the service is plaintext h2c
(`allowHTTP1: false`); `wget` cannot see it at all and would report a dead service as
healthy.

`scripts/container-e2e.sh` runs the full scenario against a built image — healthcheck,
`/healthz`, reflection, a real RPC, gRPC health and SIGTERM as PID 1 — and CI runs it for
both runtimes.

## Next

- [hris](../hris/) — the same codebase running as a monolith **or** as
  microservices, with cross-service `ctx.call` and an event bus.
- [Service Catalog guide](https://connectum.dev/en/guide/service-communication/service-catalog).
