# Production-Ready Example

Docker containerization files for deploying Connectum gRPC/ConnectRPC microservices in production.

Connectum runs on Node.js 25.2.0+ with native TypeScript execution. This means **no build step** is required -- TypeScript source files are copied directly into the container alongside `node_modules`.

## Files

| File | Description |
|---|---|
| `Dockerfile` | Recommended multi-stage Dockerfile based on `node:25-slim` (~200 MB) |
| `Dockerfile.alpine` | Alpine variant for size-optimized images (~140 MB), no native glibc modules |
| `.dockerignore` | Excludes tests, dev files, IDE configs, and proto sources from the image |
| `docker-compose.yml` | Multi-service dev environment with two Connectum services and full observability stack |
| `otel-collector-config.yaml` | OpenTelemetry Collector configuration for traces, metrics, and logs |

## Quick Start

### Build a single service

```bash
docker build -t my-service .
docker run -p 5000:5000 my-service
```

### Run the full stack with Docker Compose

```bash
docker compose up
```

This starts:
- **order-service** on port `5000`
- **inventory-service** on port `5001`
- **OTel Collector** on ports `4317` (gRPC), `4318` (HTTP), `8889` (Prometheus)
- **Jaeger UI** on port `16686`
- **Prometheus** on port `9090`
- **Grafana** on port `3000` (login: admin/admin)

## Dockerfile Highlights

- **Multi-stage build**: Dependencies are installed in a separate stage for optimal layer caching.
- **Production-only deps**: `pnpm install --frozen-lockfile --prod` excludes devDependencies (50-70% smaller `node_modules`).
- **Non-root user**: The `connectum` user runs the application for security.
- **Health checks**: Built-in `HEALTHCHECK` using the HTTP `/healthz` endpoint from `@connectum/healthcheck`.
- **Native TypeScript**: `node --experimental-strip-types src/index.ts` -- no transpilation step.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `NODE_ENV` | Runtime environment | `development` |
| `PORT` | Server listen port | `5000` |
| `LISTEN` | Bind address | `0.0.0.0` |
| `LOG_LEVEL` | Log verbosity (`debug`, `info`, `warn`, `error`) | `info` |
| `LOG_FORMAT` | Log output format (`json`, `pretty`) | `json` |
| `HTTP_HEALTH_ENABLED` | Enable HTTP health endpoints | `false` |
| `GRACEFUL_SHUTDOWN_ENABLED` | Enable graceful shutdown on SIGTERM/SIGINT | `true` |
| `GRACEFUL_SHUTDOWN_TIMEOUT_MS` | Shutdown timeout in ms | `30000` |
| `OTEL_SERVICE_NAME` | OpenTelemetry service name | `connectum-service` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector endpoint | -- |

## Documentation

See [Docker Containerization](../../docs/en/production/docker.md) for the full guide including image optimization tips and Alpine variant details.
