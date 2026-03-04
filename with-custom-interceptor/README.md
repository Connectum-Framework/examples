# Custom Interceptor Example

Demonstrates how to write and use **custom ConnectRPC interceptors** with Connectum.

## What this example shows

- **API Key Authentication** — interceptor that validates `x-api-key` header for specific RPC methods
- **Rate Limiting** — interceptor that limits request rate per client using a fixed-window counter
- **Interceptor Composition** — combining default interceptors from `@connectum/interceptors` with custom ones

## Project structure

```
src/
├── index.ts                          # Server entry point
├── interceptors/
│   ├── apiKeyInterceptor.ts          # API key auth interceptor
│   └── rateLimitInterceptor.ts       # Rate limiting interceptor
└── services/
    └── echoService.ts                # Echo service (3 RPC methods)
proto/echo/v1/echo.proto              # Service definition
tests/e2e/e2e.test.ts                 # End-to-end tests
```

## Running

```bash
pnpm install
pnpm build:proto
pnpm start
```

## Testing

```bash
pnpm test
```

## Manual testing with grpcurl

```bash
# Basic echo (no auth required)
grpcurl -plaintext -d '{"message": "Hello"}' localhost:5000 echo.v1.EchoService/Echo

# Secure echo with API key
grpcurl -plaintext -H 'x-api-key: test-api-key-123' -d '{"message": "Secret"}' localhost:5000 echo.v1.EchoService/SecureEcho

# Rate-limited echo
grpcurl -plaintext -d '{"message": "Test"}' localhost:5000 echo.v1.EchoService/RateLimitedEcho
```
