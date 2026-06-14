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
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node.js"></a>
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
| [getting-started](getting-started/) | Quickstart — one service | `defineService`, health, reflection, default interceptors, graceful shutdown; Node/Bun/tsx | Ready |
| [performance-test-server](performance-test-server/) | k6 benchmarking server | 5 parallel servers, interceptor overhead measurement, ports 8080-8084 | Ready |
| [extensions/redact](extensions/redact/) | Sensitive data redaction | Proto custom field options, `createRedactInterceptor()` | Ready |
| [interceptors/jwt](interceptors/jwt/) | Client-side JWT interceptor | Bearer token injection, `createAddTokenInterceptor()` | Ready |
| [with-custom-interceptor](with-custom-interceptor/) | Echo service with custom interceptors | API key auth, rate limiting | Ready |
| [hris](hris/) | Monolith **or** microservices — one codebase | `defineService` + catalog + `ctx.call` (in-process vs remote by env) + EventBus saga | Ready |
| [car-sharing](car-sharing/) | Enterprise deploy — Kubernetes + Istio | Split microservices + JWT/proto authz gateway + OpenTelemetry; k8s/Istio manifests (mTLS, canary) | Ready |
| [with-events-kafka](with-events-kafka/) | EventBus with Kafka | Event-driven microservices, consumer groups | Ready |
| [with-events-redpanda](with-events-redpanda/) | EventBus with Redpanda | Saga choreography, custom topics, Redpanda Console | Ready |
| [with-events-valkey](with-events-valkey/) | EventBus with Valkey (Redis) | Redis Streams adapter, lightweight event bus | Ready |
| [with-events-amqp](with-events-amqp/) | EventBus with RabbitMQ | AMQP adapter, topic exchange, Management UI | Ready |
| [with-events-dlq](with-events-dlq/) | EventBus Dead Letter Queue | DLQ service, retry policies, failed event inspection | Ready |
| [o11y-coroot](o11y-coroot/) | Observability with Coroot | Distributed tracing, custom metrics, structured logs, service map | Ready |

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22.13.0, or [Bun](https://bun.sh/) >= 1.3.6, or [tsx](https://tsx.is/) >= 4.21 (for TypeScript source in your project)
- [pnpm](https://pnpm.io/) >= 10

## Quick Start

```bash
git clone https://github.com/Connectum-Framework/examples.git
cd examples/getting-started
pnpm install
pnpm dev
```

The greeter service starts on port `5000` with gRPC Health Check, Server Reflection, and default interceptors enabled.

Test with grpcurl:

```bash
grpcurl -plaintext -d '{"name": "World"}' localhost:5000 greeter.v1.GreeterService/SayHello
```

## Enterprise deployment

The [car-sharing](car-sharing/) example demonstrates a split-microservices
deployment with a JWT/proto-authz gateway and OpenTelemetry, plus the manifests
to run it:

- **Kubernetes** — per-service Deployment / Service / HPA / RBAC, single
  role-selectable image (`SERVICES` env), `perServiceEnvResolver` wiring
  cross-service `ctx.call` across pods.
- **Istio** — PeerAuthentication mTLS (STRICT), AuthorizationPolicy, VirtualService /
  DestinationRule, a canary example.

See [car-sharing/README.md](car-sharing/README.md) for details.

## Dependencies

The catalog examples (getting-started, hris, car-sharing) use the 1.0.0
service-catalog API. Until it is published, install them against local packages
with `CONNECTUM_LOCAL=1` (see each example's README). The remaining examples use
published `@connectum/*` packages from npm — just `pnpm install`.

## License

[Apache License 2.0](LICENSE) · Built by [Highload.Zone](https://highload.zone)
