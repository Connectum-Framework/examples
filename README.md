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
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D25.2-brightgreen" alt="Node.js"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-Compiled-blue" alt="TypeScript"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"></a>
</p>

<p align="center">
  <a href="https://github.com/Connectum-Framework/connectum">Framework</a> &middot;
  <a href="https://connectum.dev">Documentation</a> &middot;
  <a href="https://connectum.dev/en/guide/quickstart">Quickstart</a>
</p>

---

Runnable examples demonstrating Connectum features — from a one-service [quickstart](getting-started/) to a monolith-or-microservices [HR system](hris/) and a [car-sharing](car-sharing/) deployment example with Kubernetes and Istio manifests.

## Examples

| Example | What it demonstrates |
|---------|----------------------|
| [getting-started](getting-started/) | One service with `defineService`, health checks, reflection, default interceptors and graceful shutdown; Node.js, Bun and tsx run scripts |
| [performance-test-server](performance-test-server/) | k6 benchmarking across six server configurations on ports 8080–8085; the OTLP export server on 8085 is opt-in |
| [extensions/redact](extensions/redact/) | Example interceptor that redacts fields marked with custom protobuf option stubs |
| [interceptors/jwt](interceptors/jwt/) | Client interceptor that adds a Bearer token to outgoing RPCs |
| [with-custom-interceptor](with-custom-interceptor/) | Echo service with API-key authentication and per-client rate limiting |
| [hris](hris/) | One codebase for a monolith or split services, with `ctx.call`, EventBus and a durable onboarding workflow |
| [car-sharing](car-sharing/) | Kubernetes and Istio manifests, service authentication, a Temporal trip workflow and a Compose Ory identity demo |
| [with-events-kafka](with-events-kafka/) | Event-driven microservices using Kafka and consumer groups |
| [with-events-redpanda](with-events-redpanda/) | Event-driven microservices using Redpanda, custom topics and Redpanda Console |
| [with-events-valkey](with-events-valkey/) | Event-driven microservices using Redis Streams on Valkey |
| [with-events-amqp](with-events-amqp/) | Event-driven microservices using RabbitMQ topic exchanges |
| [with-events-dlq](with-events-dlq/) | NATS JetStream retries and dead-letter event inspection |
| [o11y-coroot](o11y-coroot/) | Docker Compose demo for distributed traces, metrics, logs and a Coroot service map |

## Prerequisites

- [Node.js](https://nodejs.org/) >= 25.2.0 for examples that run TypeScript directly. Published Connectum packages support Node.js >= 22.13.0; see [Runtime Compatibility](https://connectum.dev/en/guide/runtime-compatibility). Node.js 25 reached end of life on 2026-06-01 ([release schedule](https://github.com/nodejs/Release/blob/main/schedule.json)); use Node.js 26 on the host (the example tests were run on 26.11). The example Dockerfiles still build on `node:25-slim` (`o11y-coroot` on `node:22-slim`).
- [pnpm](https://pnpm.io/); the Dockerfiles and CI lockfile checks use pnpm 12.4.1.
- Docker Engine and Docker Compose for examples with broker or observability stacks.

## Quick Start

```bash
git clone https://github.com/Connectum-Framework/examples.git
cd examples/getting-started
pnpm install
pnpm start
```

`pnpm start` generates the protobuf code and starts the greeter on port `5000` with gRPC Health Check, Server Reflection, and default interceptors enabled. Keep it running, then open another terminal in `examples/getting-started` for the grpcurl command below.

Test with grpcurl:

```bash
grpcurl -plaintext -d '{"name": "World"}' localhost:5000 greeter.v1.GreeterService/SayHello
```

## Car-sharing deployment example

The [car-sharing](car-sharing/) example demonstrates a split-microservices
deployment with a JWT/proto-authz gateway, a durable trip saga with
[Temporal](https://temporal.io), and OpenTelemetry, plus the manifests to run
it:

- **Kubernetes** — per-service Deployment / Service / HPA / RBAC, single
  role-selectable image (`SERVICES` env), `perServiceEnvResolver` wiring
  cross-service `ctx.call` across pods.
- **Istio** — PeerAuthentication mTLS (STRICT), AuthorizationPolicy, VirtualService /
  DestinationRule, a canary example.
- **Temporal** — durable `TripWorkflow` saga (reserve → charge → settle) with
  automatic LIFO compensation; a separate worker process keeps the RPC roles
  build-free.

See [car-sharing/README.md](car-sharing/README.md) for details.

## Dependencies

Installable examples declare their `@connectum/*` dependencies in their
`package.json`; `pnpm install` resolves the versions allowed by each manifest.
The `getting-started` example intentionally has no committed lockfile because it
is also the base copied by `connectum init`.

Every installable example except getting-started commits its `pnpm-lock.yaml`
(`extensions/redact` and `interceptors/jwt` are source examples without a
`package.json`). Docker images install from their lockfile with
`pnpm install --frozen-lockfile`. After
changing an example's `package.json` or `pnpm-workspace.yaml`, run `pnpm install`
in that example and commit the updated lockfile. getting-started ships without
one because it is the base `connectum init` copies into new projects.

### Testing against unreleased framework builds

To run an example against locally packed `@connectum/*` tarballs instead of the
published packages, name the repository's `.pnpmfile.cjs` explicitly (the path
is relative to the example directory). Export the variables for every pnpm
command, not only for the install: before `pnpm run` and `pnpm exec`, pnpm 12
checks the dependencies and reinstalls the published versions when the hook is
not named. pnpm 12 reads only the uppercase `PNPM_CONFIG_PNPMFILE`.

The local install can rewrite the example's lockfile. Before starting, make sure
the target lockfile has no existing staged or unstaged changes; stop and preserve
them if it is already modified. The restore command below is safe only after
that check.

```bash
cd with-custom-interceptor
git diff --quiet -- pnpm-lock.yaml && git diff --cached --quiet -- pnpm-lock.yaml || {
  echo "Stop: preserve the existing pnpm-lock.yaml changes before continuing." >&2
  exit 1
}
export CONNECTUM_LOCAL=1 PNPM_CONFIG_PNPMFILE=../.pnpmfile.cjs
pnpm install
readlink -f node_modules/@connectum/core   # must name a .tgz, see below
pnpm build:proto && pnpm test
readlink -f node_modules/@connectum/core   # still the .tgz
# back to the published packages pinned by the committed lockfile:
unset CONNECTUM_LOCAL PNPM_CONFIG_PNPMFILE
git restore --source=HEAD --worktree -- pnpm-lock.yaml
pnpm install --frozen-lockfile
```

The hook reads the tarballs from a `pack/` directory next to this repository's
checkout; for a package with no tarball there it silently keeps the published
version, which is why the `readlink` check matters. Restore the lockfile from git rather than with a plain `pnpm install`: after the
local install pnpm re-resolves the ranges in `package.json` and can move
`@connectum/*` to newer published versions than the committed lockfile pins.
In getting-started, which has no committed lockfile, delete the generated
`pnpm-lock.yaml` and run `pnpm install` instead. Remove it only if it did not
exist before the local-mode install; otherwise restore the original file you
preserved first. Never commit a lockfile produced in this mode: it points at the
local tarballs.

`extensions/redact` uses temporary protobuf extension stubs; it does not ship a
generated contract. See that example's README for the limitation.

## License

[Apache License 2.0](LICENSE) · Built by [Highload.Zone](https://highload.zone)
