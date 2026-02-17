# Basic Service — Node.js

A minimal gRPC/ConnectRPC service built with [Connectum](https://github.com/Connectum-Framework/connectum), running on **Node.js 18+**. `@connectum/*` packages ship compiled JavaScript and type declarations, so no special loader or build step is needed.

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

## Project Structure

```
basic-service-node/
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
| `pnpm start` | Start the server |
| `pnpm dev` | Start with `--watch` (auto-restart on changes) |
| `pnpm build:proto` | Generate TypeScript from `.proto` files |
| `pnpm typecheck` | Run `tsc --noEmit` |
| `pnpm buf:lint` | Lint proto files |

## Alternative Runtimes

The same Connectum service can run on different runtimes:

- **[basic-service-bun](../basic-service-bun/)** — Bun runtime (built-in TS support, no loader needed)
- **[basic-service-tsx](../basic-service-tsx/)** — Any Node.js via tsx (universal, no version constraint)

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
