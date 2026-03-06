# Performance Test Server

Dedicated server for k6 performance benchmarking with configurable interceptor chains.

## Purpose

This server runs **5 parallel instances** on different ports, each with a different interceptor configuration:

| Port | Configuration | Purpose |
|------|---------------|---------|
| 8081 | **Baseline** (no interceptors) | Measure baseline latency without any overhead |
| 8082 | **Validation only** | Measure validation interceptor overhead |
| 8083 | **Logger only** | Measure logger interceptor overhead |
| 8084 | **Tracing only** | Measure tracing interceptor overhead |
| 8080 | **Full chain** (all interceptors) | Measure total overhead with all interceptors |

This allows k6 benchmarks to accurately measure the overhead introduced by each interceptor.

## Requirements

- **Node.js**: >=25.2.0
- **pnpm**: >=10

## Installation

From project root:

```bash
# Install dependencies
pnpm install

# Generate proto files
cd examples/performance-test-server
pnpm build:proto
```

## Running the Server

```bash
# From project root
node examples/performance-test-server/src/index.ts

# Or with auto-reload during development
node --watch examples/performance-test-server/src/index.ts
```

Expected output:

```
Starting Performance Test Server...

Starting 5 server configurations:

All servers started successfully!

Port | Configuration
-----|-----------------------------------
8081 | Baseline (no interceptors)
8082 | Validation only
8083 | Logger only
8084 | OTel (tracing + metrics) only
8080 | Full chain (all interceptors)

Ready for k6 benchmarks!

Run benchmarks with:
  k6 run k6/basic-load.js
  k6 run k6/interceptor-overhead.js

Press Ctrl+C to shutdown all servers
```

## Docker Benchmarks

The recommended way to run benchmarks is via Docker Compose. This avoids local setup, uses TLS for HTTP/2 ALPN negotiation, and produces reproducible results.

### Prerequisites

- Docker and Docker Compose

### Interceptor Overhead (primary benchmark)

Measures the p50/p95/p99 latency overhead of each interceptor configuration:

```bash
docker compose up k6-interceptor-overhead --build --abort-on-container-exit
```

### Basic Load Test

Stress-tests the full-chain configuration for 7 minutes total, peaking at 100 concurrent VUs (ramp-up → plateau → cooldown):

```bash
docker compose --profile load up k6-basic-load --build --abort-on-container-exit
```

### Cleanup

```bash
docker compose --profile load down --rmi local -v
```

### Environment Variables

k6 scripts accept the following environment variables (set via `docker-compose.yml` or `--env`):

| Variable | Default | Used by |
|----------|---------|---------|
| `PROTOCOL` | `https` | interceptor-overhead |
| `BASE_HOST` | `server` | interceptor-overhead |
| `BASE_URL` | `https://server:8080` | basic-load |
| `BASELINE_PORT` | `8081` | interceptor-overhead |
| `VALIDATION_PORT` | `8082` | interceptor-overhead |
| `LOGGER_PORT` | `8083` | interceptor-overhead |
| `TRACING_PORT` | `8084` | interceptor-overhead |
| `FULLCHAIN_PORT` | `8080` | interceptor-overhead |

## Testing

### Health Check

Verify all servers are running:

```bash
# Baseline (no interceptors)
curl http://localhost:8081/grpc.health.v1.Health/Check

# Validation only
curl http://localhost:8082/grpc.health.v1.Health/Check

# Logger only
curl http://localhost:8083/grpc.health.v1.Health/Check

# Tracing only
curl http://localhost:8084/grpc.health.v1.Health/Check

# Full chain
curl http://localhost:8080/grpc.health.v1.Health/Check
```

### Manual Test

Test individual configurations:

```bash
# Baseline (fastest - no interceptors)
grpcurl -plaintext -d '{"name": "Baseline"}' localhost:8081 greeter.v1.GreeterService/SayHello

# Validation only
grpcurl -plaintext -d '{"name": "Validation"}' localhost:8082 greeter.v1.GreeterService/SayHello

# Full chain (slowest - all interceptors)
grpcurl -plaintext -d '{"name": "FullChain"}' localhost:8080 greeter.v1.GreeterService/SayHello
```

## Service Implementation

The benchmark service (`benchmarkService.ts`) is intentionally **minimal**:

- No console logging (reduces noise in benchmarks)
- No async I/O operations (pure CPU-bound)
- Minimal processing (just string concatenation)

This ensures we measure **interceptor overhead** only, not service logic overhead.

## Interceptor Configurations

### Baseline (Port 8081)

```typescript
interceptors: [] // NO interceptors - pure baseline
```

### Validation Only (Port 8082)

```typescript
interceptors: createDefaultInterceptors({
  errorHandler: false,
  timeout: false,
  bulkhead: false,
  circuitBreaker: false,
  retry: false,
  validation: true,
  serializer: false,
})
```

### Logger Only (Port 8083)

```typescript
interceptors: [
  createLoggerInterceptor({
    level: "error", // Minimal logging
    skipHealthCheck: true,
  }),
]
```

### OTel / Tracing Only (Port 8084)

```typescript
interceptors: [
  createOtelInterceptor({
    filter: ({ service }) => !service.includes("grpc.health"),
  }),
]
```

### Full Chain (Port 8080)

```typescript
interceptors: [
  ...createDefaultInterceptors({
    errorHandler: { logErrors: true, includeStackTrace: true },
    serializer: true,
    validation: true,
  }),
  createLoggerInterceptor({ level: "error", skipHealthCheck: true }),
  createOtelInterceptor({
    filter: ({ service }) => !service.includes("grpc.health"),
  }),
]
```

## Performance Results

**Target: < 2ms overhead per interceptor**

Results from Docker benchmarks (10 VUs, 2 min duration, TLS/HTTP2):

### Interceptor Overhead

| Configuration | p50 | p90 | p95 | p99 |
|---------------|-----|-----|-----|-----|
| Baseline (no interceptors) | 2.36ms | 3.58ms | 4.40ms | - |
| Validation only | 2.59ms | 4.43ms | 5.00ms | - |
| Logger only | 2.80ms | 4.71ms | 5.27ms | - |
| OTel (tracing + metrics) | 2.94ms | 5.15ms | 5.80ms | - |
| Full chain (all interceptors) | 3.45ms | 5.25ms | 5.89ms | - |

**Per interceptor overhead**: (Full chain p95 - Baseline p95) / interceptors = (5.89 - 4.40) / 9 = **0.17ms** per interceptor

All thresholds passed:
- Baseline p95 < 10ms: 4.40ms
- Full chain p95 < 30ms: 5.89ms
- All success rates: 100%

### Basic Load Test (100 VUs, 7 min)

| Metric | Value |
|--------|-------|
| p50 latency | 3.04ms |
| p95 latency | 37.37ms |
| Throughput | ~789 req/s |
| Error rate | 0.00% |
| Total requests | 331,309 |

## k6 Scenarios

Benchmark scripts are located in the `k6/` directory:

- `k6/interceptor-overhead.js` - Uses **all ports** to compare interceptor overhead
- `k6/basic-load.js` - Uses port 8080 (full chain) with ramping VUs

## Troubleshooting

### Port already in use

```bash
# Check what's using port 8080
lsof -i :8080

# Kill the process
kill -9 <PID>

# Or change port in src/index.ts
```

### Proto generation fails

```bash
# Regenerate proto files
pnpm build:proto
```

### Servers fail to start

```bash
# Check Node.js version (must be >=25.2.0)
node --version

# Check logs for errors
node src/index.ts

# Ensure dependencies are installed
pnpm install
```

## License

Apache 2.0
