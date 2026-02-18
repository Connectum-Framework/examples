<p align="center">
<a href="https://connectum.dev">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://connectum.dev/assets/splash-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://connectum.dev/assets/splash.png">
  <img alt="Connectum — Microservices Framework" src="https://connectum.dev/assets/splash.png" width="600">
</picture>
</a>
</p>

<p align="center">
  <strong>Examples and templates for Connectum framework</strong>
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node.js"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-Compiled-blue" alt="TypeScript"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"></a>
</p>

<p align="center">
  <a href="https://github.com/Connectum-Framework/connectum">Framework</a> &middot;
  <a href="https://connectum.dev">Documentation</a> &middot;
  <a href="https://connectum.dev/en/guide/quickstart">Quickstart</a>
</p>

---

Ready-to-run examples demonstrating Connectum features — from a minimal greeter service to production deployment configs with Docker, Kubernetes, Istio, and Envoy.

## Examples

| Example | Description | Highlights | Status |
|---------|-------------|------------|--------|
| [basic-service-node](basic-service-node/) | Basic service — Node.js | Direct execution, `@connectum/*` packages ship compiled JS | Ready |
| [basic-service-bun](basic-service-bun/) | Basic service — Bun | Zero-config TypeScript, no loader needed | Ready |
| [basic-service-tsx](basic-service-tsx/) | Basic service — tsx | Universal TS runner, works on any Node.js 18+ | Ready |
| [performance-test-server](performance-test-server/) | k6 benchmarking server | 5 parallel servers, interceptor overhead measurement, ports 8080-8084 | Ready |
| [extensions/redact](extensions/redact/) | Sensitive data redaction | Proto custom field options, `createRedactInterceptor()` | Ready |
| [interceptors/jwt](interceptors/jwt/) | Client-side JWT interceptor | Bearer token injection, `createAddTokenInterceptor()` | Ready |
| [with-custom-interceptor](with-custom-interceptor/) | Echo service with custom interceptors | API key auth, rate limiting | WIP |
| [production-ready](production-ready/) | Production deployment bundle | Docker, Compose, K8s, Istio, Envoy | Ready |

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18.0.0, or [Bun](https://bun.sh/) >= 1.3.6, or [tsx](https://tsx.is/) >= 4.21 (for TypeScript source in your project)
- [pnpm](https://pnpm.io/) >= 10

## Quick Start

```bash
git clone https://github.com/Connectum-Framework/examples.git
cd examples/basic-service-node
pnpm install
pnpm dev
```

The greeter service starts on port `5000` with gRPC Health Check, Server Reflection, and default interceptors enabled.

Test with grpcurl:

```bash
grpcurl -plaintext -d '{"name": "World"}' localhost:5000 greeter.v1.GreeterService/SayHello
```

## Production Ready

The [production-ready](production-ready/) example provides a complete deployment bundle:

- **Docker** — Multi-stage Dockerfiles (Debian ~200MB, Alpine ~140MB), non-root user, built-in health check
- **Docker Compose** — Service stack with OpenTelemetry Collector, Jaeger, Prometheus, Grafana
- **Kubernetes** — Deployment, Service, HPA, RBAC, TLS secrets
- **Istio** — mTLS, AuthorizationPolicy, canary deployments, header-based routing
- **Envoy Gateway** — Routing, rate limiting, Swagger UI

See [production-ready/README.md](production-ready/README.md) for details.

## Dependencies Note

Examples reference `@connectum/*` packages via `workspace:^` and `catalog:` protocols. For standalone usage outside this workspace, replace them with published versions from npm:

```json
{
  "dependencies": {
    "@connectum/core": "^0.x.x",
    "@connectum/healthcheck": "^0.x.x",
    "@connectum/interceptors": "^0.x.x"
  }
}
```

## License

[Apache License 2.0](LICENSE) · Built by [Highload.Zone](https://highload.zone)
