# Auth Example -- JWT + Authorization

A gRPC/ConnectRPC service built with [Connectum](https://github.com/Connectum-Framework/connectum) that demonstrates server-side JWT authentication and declarative authorization using `@connectum/auth`.

Demonstrates:

- JWT authentication interceptor (`createJwtAuthInterceptor`)
- Declarative authorization rules (`createAuthzInterceptor`) with public, authenticated, and admin access levels
- Auth context access in handlers via `getAuthContext()` and `requireAuthContext()`
- Test token generation at startup for local development
- Health checks (gRPC + HTTP) via `@connectum/healthcheck`
- Server reflection via `@connectum/reflection`

## Prerequisites

- **Node.js** >= 25.2.0 (native TypeScript execution)
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

The server starts on `http://localhost:5000` and prints sample JWT tokens and curl commands for testing.

## Project Structure

```
auth/
├── proto/greeter/v1/greeter.proto   # Service definition (3 RPC methods)
├── gen/                              # Generated code (git-ignored)
├── src/
│   ├── services/greeterService.ts   # RPC handlers with auth context access
│   └── index.ts                     # Server setup with JWT auth + authz
├── buf.yaml                          # Buf module config
├── buf.gen.yaml                      # Buf code generation config
├── tsconfig.json
└── package.json
```

## How It Works

The example exposes three RPC methods with different authorization levels:

### SayHello -- Public

No token required. Anyone can call this method. If a valid JWT happens to be present, the response includes the caller's identity.

### SayGoodbye -- Authenticated

Requires a valid JWT. The handler uses `requireAuthContext()` to access the authenticated user's identity. Requests without a token receive `UNAUTHENTICATED` error.

### SaySecret -- Admin Only

Requires a valid JWT **and** the `admin` role. The authorization interceptor checks roles before the handler runs. Users without the `admin` role receive `PERMISSION_DENIED` error.

## Testing

When the server starts, it generates two sample JWT tokens and prints curl commands. You can copy-paste them directly.

### 1. Public call (no token needed)

```bash
curl -s -X POST http://localhost:5000/greeter.v1.GreeterService/SayHello \
  -H "Content-Type: application/json" \
  -d '{"name":"World"}'
```

Expected: `{"message":"Hello, World!"}`

### 2. Authenticated call (user token)

```bash
curl -s -X POST http://localhost:5000/greeter.v1.GreeterService/SayGoodbye \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <USER_TOKEN>" \
  -d '{"name":"Alice"}'
```

Expected: `{"message":"Goodbye, Alice! (from Alice)"}`

### 3. Admin call (admin token)

```bash
curl -s -X POST http://localhost:5000/greeter.v1.GreeterService/SaySecret \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -d '{"name":"Bob"}'
```

Expected: `{"message":"Hello, Bob!","secret":"The admin secret is 42. Verified by admin-1 with roles: admin"}`

### 4. Missing token (should fail)

```bash
curl -s -X POST http://localhost:5000/greeter.v1.GreeterService/SayGoodbye \
  -H "Content-Type: application/json" \
  -d '{"name":"Eve"}'
```

Expected: `UNAUTHENTICATED` error

### 5. Insufficient permissions (should fail)

```bash
curl -s -X POST http://localhost:5000/greeter.v1.GreeterService/SaySecret \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <USER_TOKEN>" \
  -d '{"name":"Alice"}'
```

Expected: `PERMISSION_DENIED` error

Replace `<USER_TOKEN>` and `<ADMIN_TOKEN>` with the tokens printed by the server at startup.

## Interceptor Chain

The interceptors execute in the following order for each request:

```
Request
  |
  v
defaultInterceptors     (error handler, timeout, bulkhead)
  |
  v
jwtAuth                 (extract + verify JWT, set AuthContext)
  |
  v
authz                   (evaluate rules against AuthContext)
  |
  v
Handler                 (service implementation)
```

- **jwtAuth** skips methods listed in `skipMethods` (SayHello, Health).
- **authz** skips the same public methods and applies declarative rules to everything else.
- Methods not matching any authz rule fall through to `defaultPolicy: "deny"`.

## Available Scripts

| Script | Description |
|--------|-------------|
| `pnpm start` | Start the server |
| `pnpm dev` | Start with `--watch` (auto-restart on changes) |
| `pnpm build:proto` | Generate TypeScript from `.proto` files |
| `pnpm typecheck` | Run `tsc --noEmit` |
| `pnpm buf:lint` | Lint proto files |

## Related

- **[basic-service-node](../basic-service-node/)** -- Minimal service without auth
- **[interceptors](../interceptors/)** -- Custom interceptor examples
- **[@connectum/auth](https://github.com/Connectum-Framework/connectum/tree/main/packages/auth)** -- Auth package documentation

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
