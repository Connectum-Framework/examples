# Basic Service Example

A minimal standalone example of using the Connectum framework to create a ConnectRPC service.

> This example is a self-contained project. It can be cloned and run independently -- `@connectum/*` dependencies are installed from the npm registry.

## What this demonstrates

- Simple gRPC/ConnectRPC service (Greeter)
- Using the `createServer()` API from `@connectum/core`
- Health check protocol (gRPC + HTTP) via `@connectum/healthcheck`
- Server reflection protocol via `@connectum/reflection`
- Default interceptors (error handler, timeout, bulkhead) via `@connectum/interceptors`
- Lifecycle hooks (start, ready, stop, error)
- Graceful shutdown
- Works on Node.js >= 18.0.0 (`@connectum/*` packages ship compiled JS)

## Project Structure

```
basic-service/
├── proto/
│   └── greeter/v1/
│       └── greeter.proto         # Proto definition
├── gen/                          # Generated TypeScript code (git-ignored)
│   └── greeter/v1/
│       └── greeter_pb.ts         # Messages, schemas & service descriptor
├── src/
│   ├── services/
│   │   └── greeterService.ts     # Service implementation
│   └── index.ts                  # Main entry point
├── buf.yaml                      # Buf v2 module configuration
├── buf.gen.yaml                  # Buf v2 code generation config
├── tsconfig.json                 # TypeScript configuration
├── package.json
└── README.md
```

## Prerequisites

- **Node.js** >= 18.0.0, or **Bun** >= 1.3.6, or **tsx** >= 4.21 (for TypeScript source in your project)
- **pnpm** >= 10.0.0

> **Note**: The `buf` CLI is installed automatically via the `@bufbuild/buf` npm package (devDependency).

## Installation

```bash
# Clone the repository (or copy the directory)
git clone https://github.com/Connectum-Framework/examples.git
cd examples/basic-service

# Install dependencies
pnpm install

# Generate proto code (buf v2)
pnpm run build:proto
```

## Running

### Node.js

```bash
# Development mode (with auto-reload)
pnpm dev

# Production mode
pnpm start
```

`@connectum/*` packages ship compiled JavaScript and type declarations, so no special loader is needed.

### Bun

Bun natively supports TypeScript in `node_modules`, so no loader is needed:

```bash
bun src/index.ts
```

You should see:

```
🚀 Starting Basic Service Example...

📡 Server is starting...

✅ Server ready on 0.0.0.0:5000

📡 Available services:
  - greeter.v1.GreeterService
  - grpc.health.v1.Health
  - grpc.reflection.v1.ServerReflection

🧪 Test with grpcurl:
  grpcurl -plaintext localhost:5000 list
  grpcurl -plaintext -d '{"name": "Alice"}' localhost:5000 greeter.v1.GreeterService/SayHello
  curl http://localhost:5000/healthz

🛑 Press Ctrl+C to shutdown gracefully
```

## Testing

### With grpcurl

#### 1. List all services (Server Reflection)

```bash
grpcurl -plaintext localhost:5000 list
```

Expected output:

```
greeter.v1.GreeterService
grpc.health.v1.Health
grpc.reflection.v1.ServerReflection
```

#### 2. Describe service

```bash
grpcurl -plaintext localhost:5000 describe greeter.v1.GreeterService
```

#### 3. Call SayHello method

```bash
grpcurl -plaintext -d '{"name": "Alice"}' \
  localhost:5000 \
  greeter.v1.GreeterService/SayHello
```

Expected output:

```json
{
  "message": "Hello, Alice!"
}
```

#### 4. Call SayGoodbye method

```bash
grpcurl -plaintext -d '{"name": "Bob"}' \
  localhost:5000 \
  greeter.v1.GreeterService/SayGoodbye
```

Expected output:

```json
{
  "message": "Goodbye, Bob! See you soon!"
}
```

#### 5. Health check (gRPC)

```bash
grpcurl -plaintext localhost:5000 grpc.health.v1.Health/Check
```

Expected output:

```json
{
  "status": "SERVING"
}
```

### With curl (HTTP/2)

The server runs on HTTP/2. To test via curl, you need to pass `--http2-prior-knowledge` (connect to h2c without TLS upgrade):

```bash
# SayHello
curl --http2-prior-knowledge \
  -X POST http://localhost:5000/greeter.v1.GreeterService/SayHello \
  -H "Content-Type: application/json" \
  -d '{"name": "Charlie"}'

# SayGoodbye
curl --http2-prior-knowledge \
  -X POST http://localhost:5000/greeter.v1.GreeterService/SayGoodbye \
  -H "Content-Type: application/json" \
  -d '{"name": "David"}'

# Health check (HTTP endpoint)
curl --http2-prior-knowledge http://localhost:5000/healthz
```

## Understanding the code

### 1. Proto Definition (proto/greeter/v1/greeter.proto)

```protobuf
syntax = "proto3";

package greeter.v1;

service GreeterService {
  rpc SayHello(SayHelloRequest) returns (SayHelloResponse) {}
  rpc SayGoodbye(SayGoodbyeRequest) returns (SayGoodbyeResponse) {}
}

message SayHelloRequest {
  string name = 1;
}

message SayHelloResponse {
  string message = 1;
}
```

**Key points:**
- Simple service definition with 2 methods
- Request/Response messages for each method
- `package greeter.v1` -- API versioning

### 2. Service Implementation (src/services/greeterService.ts)

```typescript
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { GreeterService } from "#gen/greeter/v1/greeter_pb.ts";
import {
  type SayGoodbyeRequest, SayGoodbyeResponseSchema,
  type SayHelloRequest, SayHelloResponseSchema,
} from "#gen/greeter/v1/greeter_pb.ts";

export function greeterServiceRoutes(router: ConnectRouter): void {
  router.service(GreeterService, {
    async sayHello(request: SayHelloRequest) {
      const name = request.name || "World";
      return create(SayHelloResponseSchema, {
        message: `Hello, ${name}!`,
      });
    },

    async sayGoodbye(request: SayGoodbyeRequest) {
      const name = request.name || "World";
      return create(SayGoodbyeResponseSchema, {
        message: `Goodbye, ${name}! See you soon!`,
      });
    },
  });
}
```

**Key points:**
- Factory function that accepts a `ConnectRouter`
- `router.service()` registers the service implementation with a type-safe descriptor
- `create()` builds type-safe response messages
- All types and descriptors are imported from a single `greeter_pb.ts` (protobuf-es v2)
- Async handlers for asynchronous logic

### 3. Main Entry Point (src/index.ts)

```typescript
import { createServer } from "@connectum/core";
import type { CreateServerOptions } from "@connectum/core";
import { Healthcheck, healthcheckManager, ServingStatus } from "@connectum/healthcheck";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { Reflection } from "@connectum/reflection";
import { greeterServiceRoutes } from "./services/greeterService.ts";

const options: CreateServerOptions = {
    services: [greeterServiceRoutes],
    port: 5000,
    host: "0.0.0.0",
    protocols: [Healthcheck({ httpEnabled: true }), Reflection()],
    interceptors: createDefaultInterceptors(),
    shutdown: { timeout: 10_000 },
};

const server = createServer(options);

server.on("ready", () => {
    healthcheckManager.update(ServingStatus.SERVING, "greeter.v1.GreeterService");
});

await server.start();
```

**Key points:**
- `createServer()` -- factory function that creates the server (does not start it)
- `CreateServerOptions` -- type-safe configuration
- Interceptors are explicitly attached via `createDefaultInterceptors()` from `@connectum/interceptors`
- Protocols (healthcheck, reflection) -- plugins registered through the `protocols` array
- Lifecycle hooks (`server.on("ready", ...)`) -- react to server state changes
- `await server.start()` -- explicit server startup
- `healthcheckManager.update()` -- sets health status after the server is ready

## Extending the example

### Add a new method

1. Update the proto file:

```protobuf
service GreeterService {
  rpc SayHello(SayHelloRequest) returns (SayHelloResponse) {}
  rpc SayGoodbye(SayGoodbyeRequest) returns (SayGoodbyeResponse) {}
  rpc SayThanks(SayThanksRequest) returns (SayThanksResponse) {}  // NEW
}

message SayThanksRequest {
  string name = 1;
}

message SayThanksResponse {
  string message = 1;
}
```

2. Regenerate proto code:

```bash
pnpm run build:proto
```

3. Implement handler:

```typescript
export function greeterServiceRoutes(router: ConnectRouter): void {
  router.service(GreeterService, {
    async sayHello(request) { /* ... */ },
    async sayGoodbye(request) { /* ... */ },

    async sayThanks(request: SayThanksRequest) {
      return create(SayThanksResponseSchema, {
        message: `Thank you, ${request.name}!`,
      });
    },
  });
}
```

### Add validation

1. Update buf.yaml:

```yaml
version: v2
modules:
  - path: proto
deps:
  - buf.build/bufbuild/protovalidate  # ADD
```

2. Add validation constraints:

```protobuf
import "buf/validate/validate.proto";

message SayHelloRequest {
  string name = 1 [
    (buf.validate.field).string.min_len = 1,
    (buf.validate.field).string.max_len = 100
  ];
}
```

3. Enable the validation interceptor (see `@connectum/interceptors` documentation).

## Next steps

1. Explore Connectum documentation: [github.com/Connectum-Framework/docs](https://github.com/Connectum-Framework/docs)
2. Check out other examples: [github.com/Connectum-Framework/examples](https://github.com/Connectum-Framework/examples)
   - `performance-test-server/` -- k6 benchmarking server
   - `production-ready/` -- production configuration (WIP)
   - `with-custom-interceptor/` -- custom interceptor (WIP)

## Troubleshooting

### Error: Cannot find module '#gen/greeter/v1/greeter_pb.ts'

**Cause**: Proto code has not been generated.

**Solution**: Generate the proto code:

```bash
pnpm run build:proto
```

### Error: node: command not found or version < 18.0.0

**Solution**: Install Node.js 18.0.0+:

```bash
# With nvm
nvm install 18
nvm use 18
```

### Server fails to start on port 5000

**Cause**: The port is already in use by another process.

**Solution**: Change the port in `src/index.ts`:

```typescript
const options: CreateServerOptions = {
    port: 5001,  // Change the port
    // ...
};
```

### curl returns an error or empty response

**Cause**: The server runs on HTTP/2 (h2c). By default, curl uses HTTP/1.1.

**Solution**: Add the `--http2-prior-knowledge` flag:

```bash
curl --http2-prior-knowledge \
  -X POST http://localhost:5000/greeter.v1.GreeterService/SayHello \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice"}'
```

## Runtime Variants

Since `@connectum/*` packages ship compiled JavaScript, any Node.js 18+ works out of the box. The same service is also available for other runtimes:

| Variant | Runtime | Directory | Notes |
|---------|---------|-----------|-------|
| **Node.js** | Node.js 18+ | [`../basic-service-node/`](../basic-service-node/) | Direct execution, no loader needed |
| **Bun** | Bun 1.3.6+ | [`../basic-service-bun/`](../basic-service-bun/) | Zero-config TypeScript, no loader needed |
| **tsx** | tsx 4.21+ (any Node.js 18+) | [`../basic-service-tsx/`](../basic-service-tsx/) | Universal TypeScript runner for your own `.ts` source |

## License

Apache 2.0
