# runn E2E Tests

Docker-based E2E test suite for all Connectum packages using [runn](https://github.com/k1LoW/runn) (YAML runbooks).

## Coverage

| Runbook | Package | Scenarios |
|---------|---------|-----------|
| 01-healthcheck-grpc | @connectum/healthcheck | gRPC Check (overall, per-service) |
| 02-healthcheck-http | @connectum/healthcheck | HTTP /healthz, /readyz, /health, ?service= |
| 03-reflection | @connectum/reflection | Service discovery via gRPC reflection |
| 04-auth-public | @connectum/auth | Public endpoint with/without token |
| 05-auth-authenticated | @connectum/auth | JWT: valid, invalid, expired, missing |
| 06-auth-admin | @connectum/auth | Admin role: admin/user/no token |
| 07-interceptors-error | @connectum/interceptors | Error codes: INTERNAL, INVALID_ARGUMENT, NOT_FOUND, PERMISSION_DENIED |
| 08-interceptors-timeout | @connectum/interceptors | Fast OK, slow DEADLINE_EXCEEDED |
| 09-core-lifecycle | @connectum/core | Multi-service, gRPC + HTTP Connect protocol |
| 10-tls-alpn | @connectum/core | gRPC over TLS + ConnectRPC HTTP over TLS |

**Implicit:** @connectum/otel — traces are sent to OTLP collector (server starts with OTel enabled).

**Not tested:** @connectum/cli (CLI utility), @connectum/testing (empty package).

## Usage

```bash
# Install dependencies and generate proto
pnpm install
pnpm build:proto

# Full E2E test via Docker
pnpm test
# or directly:
docker compose up --build --exit-code-from tests --abort-on-container-exit

# With Jaeger UI (http://localhost:16686) for manual trace inspection
pnpm test:observe
```

## Structure

```
runbooks/           # runn YAML runbooks (10 files, ~38 scenarios)
src/
  index.ts          # Test server: all Connectum packages enabled
  services/
    greeterService.ts   # GreeterService (3 authorization levels)
    testService.ts      # TestService (SlowMethod, ErrorMethod, GetTestTokens)
proto/              # Protobuf definitions
gen/                # Generated code (buf generate)
```

## Test Server

The server enables all packages:
- **core**: createServer, multi-service, 3 transport modes (h2c, HTTP/1.1, TLS+ALPN)
- **healthcheck**: gRPC + HTTP health endpoints
- **reflection**: gRPC Server Reflection
- **auth**: JWT authentication + declarative authorization
- **interceptors**: Error handler, Timeout (3s), no circuit breaker/retry/bulkhead
- **otel**: OpenTelemetry traces → OTLP collector
