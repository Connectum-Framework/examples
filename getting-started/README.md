# getting-started

The Connectum quickstart. One service, and almost no wiring — health checks,
reflection, the default interceptor chain and graceful shutdown all come from a
single `createServer` call.

> Uses `defineService`. `pnpm install` resolves the published package versions
> allowed by `package.json`. To test against locally packed framework tarballs, see
> "Testing against unreleased framework builds" in the repository README.

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

Requires Node.js >= 25.2.0 and pnpm. The optional `start:bun` and `start:tsx`
scripts require Bun or `tsx` to be installed separately.

```bash
pnpm install                     # install the @connectum/* ranges in package.json
pnpm build:proto                 # buf generate → gen/
pnpm typecheck
pnpm test                        # in-process test using a real gRPC client
```

Start the server in one terminal:

```bash
pnpm start                       # generates proto code, then serves :5000
```

Call it:

```bash
grpcurl -plaintext -d '{"name":"world"}' localhost:5000 greeter.v1.GreeterService/SayHello
# { "message": "Hello, world!" }
```

## Same code, three runtimes

The same source can run through the provided Node.js, Bun and tsx scripts:

```bash
pnpm start           # Node.js (native type stripping; Node.js >=25.2.0)
pnpm start:bun       # Bun (installed separately)
pnpm start:tsx       # tsx (installed separately)
```

## Enums in your protos

Node runs this project's TypeScript by stripping types, and `tsconfig.json` sets
`erasableSyntaxOnly`, so neither accepts a TypeScript `enum`. `buf.gen.yaml` therefore
passes `erasable_syntax=true` to protoc-gen-es, and a Protobuf enum is generated as an
object with `as const` plus a type of the same name:

```typescript
export const Color = { UNSPECIFIED: 0, RED: 1, GREEN: 2 } as const;
export type Color = (typeof Color)[keyof typeof Color] | UnknownEnum;
```

`Color.RED` works as usual. There is no reverse mapping (`Color[1]` is `undefined` and a
type error), a single value's type is `typeof Color.RED`, and an open (proto3) enum's
type also admits `UnknownEnum`.

## In a container

Two Dockerfiles, one per runtime. Both generate the proto code during the build (`gen/`
is not committed and `buf` is a devDependency), then ship production dependencies only:

```bash
docker build -t quickstart .                      # Node.js
docker build -f Dockerfile.bun -t quickstart .    # Bun

docker run --rm -d --name quickstart -p 5000:5000 quickstart
curl -fsS --http2-prior-knowledge http://localhost:5000/healthz
docker stop quickstart
```

The container runs in the background for the probe; `docker stop` removes it
because it was started with `--rm`.

The probe needs `--http2-prior-knowledge` because the service is plaintext h2c
(`allowHTTP1: false`). The successful h2c response is what the probe checks.

`scripts/container-e2e.sh` runs the full scenario against a built image — healthcheck,
`/healthz`, reflection, a real RPC, gRPC health and SIGTERM as PID 1 — and CI runs it for
both runtimes.

## Next

- [hris](../hris/) — the same codebase running as a monolith **or** as
  microservices, with cross-service `ctx.call` and an event bus.
- [Service Catalog guide](https://connectum.dev/en/guide/service-communication/service-catalog).
