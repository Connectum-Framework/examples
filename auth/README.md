# Auth Example — Proto-Based + Code-Based Authorization

A gRPC/ConnectRPC service built with [Connectum](https://github.com/Connectum-Framework/connectum) that demonstrates **two approaches to authorization side by side** using `@connectum/auth`.

## Two Approaches

### Code-Based (CodeBasedService)

Authorization rules defined in TypeScript via programmatic rules:

```typescript
const authz = createProtoAuthzInterceptor({
    defaultPolicy: "deny",
    rules: [
        { name: "codebased-public", methods: ["codebased.v1.CodeBasedService/SayHello"], effect: "allow" },
        { name: "codebased-authenticated", methods: ["codebased.v1.CodeBasedService/SayGoodbye"], effect: "allow" },
        { name: "codebased-admin-only", methods: ["codebased.v1.CodeBasedService/SaySecret"], requires: { roles: ["admin"] }, effect: "allow" },
    ],
});
```

### Proto-Based (ProtoBasedService)

Authorization rules defined in `.proto` file via custom options:

```protobuf
import "connectum/auth/v1/options.proto";

service ProtoBasedService {
  rpc SayHello(SayHelloRequest) returns (SayHelloResponse) {
    option (connectum.auth.v1.method_auth) = { public: true };
  }
  rpc SayGoodbye(SayGoodbyeRequest) returns (SayGoodbyeResponse) {}
  rpc SaySecret(SaySecretRequest) returns (SaySecretResponse) {
    option (connectum.auth.v1.method_auth) = { requires: { roles: "admin" } };
  }
}
```

Both services have identical behavior — the difference is only **where** the rules are defined.

## Prerequisites

- **Node.js** >= 25.2.0 (native TypeScript execution)
- **pnpm** >= 10

## Quick Start

```bash
pnpm install
pnpm build:proto
pnpm start
```

The server starts on `http://localhost:5000` and prints sample JWT tokens and curl commands for both services.

## Project Structure

```
auth/
├── proto/
│   ├── codebased/v1/codebased.proto       # No auth options (rules in code)
│   └── protobased/v1/protobased.proto     # Auth options in proto
├── gen/                                    # Generated code (git-ignored)
├── src/
│   ├── services/
│   │   ├── codeBasedService.ts            # Handlers (auth via programmatic rules)
│   │   └── protoBasedService.ts           # Handlers (auth via proto options)
│   └── index.ts                           # Server + interceptor configuration
├── tests/e2e/auth.test.ts                 # E2E tests for both services
├── buf.yaml                               # Buf module config (incl. auth proto)
├── buf.gen.yaml
├── tsconfig.json
└── package.json
```

## How It Works

Both services expose three RPC methods with the same authorization levels:

| Method | Auth Level | CodeBased | ProtoBased |
|--------|-----------|-----------|------------|
| `SayHello` | Public | `rules: [{ methods: [...], effect: "allow" }]` | `option (method_auth) = { public: true }` |
| `SayGoodbye` | Authenticated | `rules: [{ methods: [...], effect: "allow" }]` | No option → `defaultPolicy: "deny"` requires auth |
| `SaySecret` | Admin only | `rules: [{ requires: { roles: ["admin"] } }]` | `option (method_auth) = { requires: { roles: "admin" } }` |

### Interceptor Chain

```
Request
  │
  ▼
defaultInterceptors     (error handler, timeout, bulkhead)
  │
  ▼
jwtAuth                 (extract + verify JWT, set AuthContext)
  │                     skipMethods: CodeBased/SayHello + proto public methods + Health
  ▼
protoAuthz              (single interceptor for both approaches)
  │                     ├─ Proto options found? → Apply proto authz rules
  │                     └─ No proto options?   → Evaluate programmatic rules → defaultPolicy
  ▼
Handler                 (service implementation)
```

## Testing

### Code-Based Service

```bash
# 1. Public (no token needed)
curl -s -X POST http://localhost:5000/codebased.v1.CodeBasedService/SayHello \
  -H "Content-Type: application/json" \
  -d '{"name":"World"}'

# 2. Authenticated (user token)
curl -s -X POST http://localhost:5000/codebased.v1.CodeBasedService/SayGoodbye \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <USER_TOKEN>" \
  -d '{"name":"Alice"}'

# 3. Admin only (admin token)
curl -s -X POST http://localhost:5000/codebased.v1.CodeBasedService/SaySecret \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d '{"name":"Bob"}'
```

### Proto-Based Service

```bash
# 4. Public (no token needed — proto: public=true)
curl -s -X POST http://localhost:5000/protobased.v1.ProtoBasedService/SayHello \
  -H "Content-Type: application/json" \
  -d '{"name":"World"}'

# 5. Authenticated (user token — proto: default policy)
curl -s -X POST http://localhost:5000/protobased.v1.ProtoBasedService/SayGoodbye \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <USER_TOKEN>" \
  -d '{"name":"Alice"}'

# 6. Admin only (admin token — proto: requires roles=admin)
curl -s -X POST http://localhost:5000/protobased.v1.ProtoBasedService/SaySecret \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d '{"name":"Bob"}'
```

Replace `<USER_TOKEN>` and `<ADMIN_TOKEN>` with the tokens printed by the server at startup.

### E2E Tests

```bash
pnpm test
```

Runs all scenarios for both services: public, authenticated, admin-only, and health check.

## Available Scripts

| Script | Description |
|--------|-------------|
| `pnpm start` | Start the server |
| `pnpm dev` | Start with `--watch` (auto-restart on changes) |
| `pnpm build:proto` | Generate TypeScript from `.proto` files |
| `pnpm typecheck` | Run `tsc --noEmit` |
| `pnpm test` | Run E2E tests |
| `pnpm buf:lint` | Lint proto files |

## Related

- **[basic-service-node](../basic-service-node/)** — Minimal service without auth
- **[interceptors](../interceptors/)** — Custom interceptor examples
- **[@connectum/auth](https://github.com/Connectum-Framework/connectum/tree/main/packages/auth)** — Auth package documentation

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
