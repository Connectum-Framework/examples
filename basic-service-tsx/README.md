# Basic Service — tsx

A minimal gRPC/ConnectRPC service built with [Connectum](https://github.com/Connectum-Framework/connectum), running on **any Node.js 18+** via [tsx](https://tsx.is/) — fast TypeScript execution powered by esbuild.

Demonstrates:

- `createServer()` explicit lifecycle API
- Greeter service with two RPC methods
- Health checks (gRPC + HTTP) via `@connectum/healthcheck`
- Server reflection via `@connectum/reflection`
- Default interceptors (error handler, timeout, bulkhead) via `@connectum/interceptors`
- Graceful shutdown

## Prerequisites

- **Node.js** >= 18.0.0
- **pnpm** >= 10

## Quick Start

```bash
# Install dependencies
pnpm install

# Generate proto code
pnpm build:proto

# Start the server
pnpm start

# Or in watch mode
pnpm dev
```

The server starts on `http://localhost:5000`.

## Why tsx?

`@connectum/*` packages ship compiled JavaScript and type declarations, so they work on any Node.js 18+ without a loader. **tsx** adds value by handling your own `.ts` source files via [esbuild](https://esbuild.github.io/):

- **No build step for your code** — tsx transforms your `.ts` files on the fly
- **Fast startup** — esbuild is one of the fastest TS transformers
- **Great DX** — `tsx watch` provides instant restart on file changes

The start command is simply:

```bash
tsx src/index.ts
```

No loaders, no flags, no version constraints.

## Project Structure

```
basic-service-tsx/
├── proto/greeter/v1/greeter.proto   # Service definition
├── gen/                              # Generated code (git-ignored)
├── src/
│   ├── services/greeterService.ts   # RPC method implementations
│   └── index.ts                     # Server setup and lifecycle
├── buf.yaml                          # Buf module config
├── buf.gen.yaml                      # Buf code generation config
├── tsconfig.json
└── package.json
```

## Testing

### gRPC (via grpcurl)

```bash
# List all services
grpcurl -plaintext localhost:5000 list

# Call SayHello
grpcurl -plaintext -d '{"name": "Alice"}' localhost:5000 greeter.v1.GreeterService/SayHello

# Call SayGoodbye
grpcurl -plaintext -d '{"name": "Alice"}' localhost:5000 greeter.v1.GreeterService/SayGoodbye

# Health check (gRPC)
grpcurl -plaintext localhost:5000 grpc.health.v1.Health/Check
```

### ConnectRPC (via curl)

```bash
# Call SayHello over Connect protocol
curl \
  --header "Content-Type: application/json" \
  --data '{"name": "Alice"}' \
  http://localhost:5000/greeter.v1.GreeterService/SayHello

# HTTP health endpoint
curl http://localhost:5000/healthz
```

### gRPC over HTTP/2 (via curl)

```bash
curl \
  --http2-prior-knowledge \
  --header "Content-Type: application/grpc+proto" \
  http://localhost:5000/greeter.v1.GreeterService/SayHello
```

## Available Scripts

| Script | Description |
|--------|-------------|
| `pnpm start` | Start the server (`tsx src/index.ts`) |
| `pnpm dev` | Start with `tsx watch` (auto-restart on changes) |
| `pnpm build:proto` | Generate TypeScript from `.proto` files |
| `pnpm typecheck` | Run `tsc --noEmit` |
| `pnpm buf:lint` | Lint proto files |
| `pnpm test` | Run tests via `tsx --test` |

## When to Choose tsx

| Runtime | Node.js version | Handles your `.ts` source | Install |
|---------|----------------|---------------------------|---------|
| **tsx** | >= 18 | Yes (esbuild) | `tsx` (devDependency) |
| Node.js native | >= 22.6.0 | Yes (type stripping) | None |
| Bun | >= 1.3.6 | Yes (built-in) | Bun runtime |

Choose tsx when you want **zero-config TypeScript execution** for your own source files on any Node.js 18+.

## Alternative Runtimes

The same Connectum service can run on different runtimes:

- **[basic-service-node](../basic-service-node/)** — Node.js 18+ (direct execution, no loader needed)
- **[basic-service-bun](../basic-service-bun/)** — Bun runtime (built-in TS support, no loader needed)

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
