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

- **Node.js**: ≥25.2.0
- **pnpm**: ≥10

## Installation

From project root:

```bash
# Install dependencies
pnpm install

# Generate proto files
cd examples/performance-test-server
pnpm exec protoc -I proto \
  --es_out=gen --es_opt=target=js+dts \
  --connect-es_out=gen --connect-es_opt=target=js+dts \
  proto/*.proto
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
🚀 Starting Performance Test Server...

📊 Starting 5 server configurations:

✅ All servers started successfully!

Port | Configuration
-----|-----------------------------------
8081 | Baseline (no interceptors)
8082 | Validation only
8083 | Logger only
8084 | Tracing only
8080 | Full chain (all interceptors)

🧪 Ready for k6 benchmarks!

Run benchmarks with:
  k6 run tests/performance/scenarios/basic-load.js
  k6 run tests/performance/scenarios/stress-test.js
  k6 run tests/performance/scenarios/spike-test.js
  k6 run tests/performance/scenarios/interceptor-overhead.js

🛑 Press Ctrl+C to shutdown all servers
```

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
interceptors: {
  // All disabled
  errorHandler: false,
  logger: false,
  serializer: false,
  tracing: false,
  validation: false,
  retry: false,
  redact: false,
  circuitBreaker: false,
  timeout: false,
}
```

### Validation Only (Port 8082)

```typescript
interceptors: {
  validation: true, // ONLY validation
  // All others disabled
}
```

### Logger Only (Port 8083)

```typescript
interceptors: {
  logger: {
    level: "error", // Minimal logging
    skipHealthCheck: true,
  },
  // All others disabled
}
```

### Tracing Only (Port 8084)

```typescript
interceptors: {
  tracing: {
    skipHealthCheck: true,
  },
  // All others disabled
}
```

### Full Chain (Port 8080)

```typescript
interceptors: {
  errorHandler: true,
  logger: { level: "error" },
  serializer: true,
  tracing: true,
  validation: true,
  retry: { maxAttempts: 3 },
  circuitBreaker: true,
  timeout: { timeoutMs: 5000 },
  // All interceptors enabled
}
```

## Performance Expectations

**Target: < 2ms overhead per interceptor**

| Configuration | Expected p95 | Interceptor Count | Overhead |
|---------------|--------------|-------------------|----------|
| Baseline | ~5ms | 0 | - |
| Validation | ~7ms | 1 | ~2ms |
| Logger | ~7ms | 1 | ~2ms |
| Tracing | ~8ms | 1 | ~3ms |
| Full chain | ~15-20ms | 8-10 | ~10-15ms |

**Per interceptor overhead**: (Full chain p95 - Baseline p95) / num_interceptors ≈ 1-2ms

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
# Make sure protoc is installed
protoc --version

# Regenerate proto files
pnpm exec protoc -I proto \
  --es_out=gen --es_opt=target=js+dts \
  --connect-es_out=gen --connect-es_opt=target=js+dts \
  proto/*.proto
```

### Servers fail to start

```bash
# Check Node.js version (must be ≥25.2.0)
node --version

# Check logs for errors
node src/index.ts

# Ensure dependencies are installed
pnpm install
```

## Integration with k6 Benchmarks

This server is used by:

- `tests/performance/scenarios/basic-load.js` - Uses port 8080 (full chain)
- `tests/performance/scenarios/stress-test.js` - Uses port 8080 (full chain)
- `tests/performance/scenarios/spike-test.js` - Uses port 8080 (full chain)
- `tests/performance/scenarios/interceptor-overhead.js` - Uses **all ports** to compare

See [tests/performance/README.md](../../tests/performance/README.md) for benchmark usage.

## License

Apache 2.0
