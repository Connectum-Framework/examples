# O11y Coroot Example — Architecture Research

> **Checklist Item**: Research Coroot architecture and Docker deployment requirements
> **Date**: 2026-03-20
> **Author**: backend-developer

---

## 1. Coroot Components

### 1.1 Coroot Server (Required)

- **Image**: `ghcr.io/coroot/coroot` (Community Edition)
- **Port**: `8080` — UI + API + **built-in OTLP receiver**
- **Storage**: `/data` volume for internal metrics cache
- **Dependencies**: ClickHouse (required), Prometheus (optional)

Coroot includes a **built-in OTLP/HTTP receiver** on port 8080. Applications can send telemetry directly:
- `http://coroot:8080/v1/traces` — traces
- `http://coroot:8080/v1/metrics` — metrics
- `http://coroot:8080/v1/logs` — logs

### 1.2 ClickHouse (Required)

- **Image**: `clickhouse/clickhouse-server:24.3`
- **Ports**:
  - `8123` — HTTP interface (used for health checks)
  - `9000` — native protocol (used by Coroot for connection)
- **Stores**: logs, traces, profiles, metrics (optional)
- **Schema**: Coroot manages schema automatically via UI → Project Settings → ClickHouse
- **Recommendations**: disable query_log to save disk space, ulimits nofile 262144

### 1.3 Prometheus (Optional for Our Use Case)

- **Image**: `prom/prometheus:v2.53.5` (in the original Coroot docker-compose)
- Coroot can use **ClickHouse as an alternative to Prometheus** for metrics storage
- When both are present, Coroot prioritizes ClickHouse
- **Decision**: DO NOT include Prometheus in our example — use ClickHouse for everything

### 1.4 coroot-node-agent (EXCLUDED)

- **Image**: `ghcr.io/coroot/coroot-node-agent`
- **Requirements**: `privileged: true`, `pid: host`, mounting `/sys/kernel/tracing`, `/sys/kernel/debug`, `/sys/fs/cgroup`
- **Purpose**: eBPF agent for collecting node-level metrics, network traces, container logs, CPU profiles

#### Incompatibility with Docker Desktop (macOS/Windows)

**Status**: [Open issue #54](https://github.com/coroot/coroot-node-agent/issues/54)

Error on Docker Desktop macOS:
```
kernel tracing is not available: stat /sys/kernel/debug/tracing: no such file or directory
```

**Root causes**:
1. Docker Desktop macOS/Windows runs containers in a lightweight Linux VM that does not expose eBPF infrastructure
2. `/sys/kernel/debug` is mounted from the macOS host instead of the Linux VM
3. Docker socket is available at a non-standard path `/run/guest-services/docker.sock`

**Official stance**: "Running the agent in Docker Desktop is theoretically possible, but we'd need to make some tweaks to the code. Until these adjustments are made, it's safe to consider Docker Desktop as unsupported."

**Decision for example**: EXCLUDE node-agent. Use only OTLP ingestion from instrumented microservices.

### 1.5 coroot-cluster-agent (EXCLUDED)

- Kubernetes-only component for discovery and database metrics (Postgres, MySQL, Redis)
- Not applicable for Docker Compose deployment

---

## 2. OpenTelemetry Integration Scheme

### 2.1 Option A: Microservices → OTel Collector → Coroot (RECOMMENDED)

```
┌─────────────────┐    OTLP/HTTP     ┌──────────────────┐   OTLP/HTTP    ┌─────────┐
│  order-service   │───────────────→ │  OTel Collector   │─────────────→ │  Coroot  │
│  (port 5000)     │    :4318        │  (4317/4318)      │   :8080       │  (:8080) │
└─────────────────┘                  │                   │               └────┬─────┘
                                     │  batch processor  │                    │
┌─────────────────┐    OTLP/HTTP     │  + resource attrs │               ┌────▼──────┐
│inventory-service │───────────────→ │                   │               │ClickHouse │
│  (port 5001)     │    :4318        └──────────────────┘               │  (:9000)  │
└─────────────────┘                                                     └───────────┘
```

**Advantages**:
- Compatible with existing `production-ready` configuration (microservices already export to `otel-collector:4318`)
- OTel Collector adds batch processing, resource attributes enrichment
- Single routing point — easy to add additional exporters
- Microservices DO NOT need to change `OTEL_EXPORTER_OTLP_ENDPOINT`

### 2.2 Option B: Microservices → Coroot Directly

```
┌─────────────────┐    OTLP/HTTP
│  order-service   │───────────────→ ┌─────────┐
│  (port 5000)     │    :8080       │  Coroot  │──→ ClickHouse
└─────────────────┘                  └─────────┘
┌─────────────────┐    OTLP/HTTP
│inventory-service │───────────────→
│  (port 5001)     │    :8080
└─────────────────┘
```

**Advantages**: minimal components
**Disadvantages**: no batch processing, no data enrichment, locked to a single backend

### 2.3 Decision: Option A — Via OTel Collector

OTel Collector serves as the central hub:
- **Receivers**: OTLP gRPC (:4317) + HTTP (:4318)
- **Processors**: batch (timeout 5s, batch_size 1024)
- **Exporters**: `otlphttp` → Coroot (:8080)

Pipelines:
```yaml
traces:   [otlp] → [batch] → [otlphttp/coroot]
metrics:  [otlp] → [batch] → [otlphttp/coroot]
logs:     [otlp] → [batch] → [otlphttp/coroot]
```

---

## 3. Docker Images and Versions

| Component | Image | Version/Tag | Rationale |
|-----------|-------|-------------|-----------|
| Coroot | `ghcr.io/coroot/coroot` | latest | Community Edition, frequently updated |
| ClickHouse | `clickhouse/clickhouse-server` | `24.3` | LTS, verified in official Coroot docker-compose |
| OTel Collector | `otel/opentelemetry-collector-contrib` | `0.115.0` | Matches production-ready for consistency |
| order-service | build context | local | From `production-ready/services/order-service` |
| inventory-service | build context | local | From `production-ready/services/inventory-service` |

---

## 4. Port Configuration

### 4.1 Ports for the o11y-coroot Example

| Port | Service | Protocol | Purpose |
|------|---------|----------|---------|
| **8080** | Coroot | HTTP | UI + API + OTLP receiver |
| **9000** | ClickHouse | Native | Coroot → ClickHouse connection |
| **8123** | ClickHouse | HTTP | Health check (not mapped to host) |
| **4317** | OTel Collector | gRPC | OTLP gRPC receiver |
| **4318** | OTel Collector | HTTP | OTLP HTTP receiver |
| **5000** | order-service | HTTP/2 | gRPC/Connect service |
| **5001** | inventory-service | HTTP/2 | gRPC/Connect service |

### 4.2 Port Conflict Analysis

| Port | o11y-coroot | Conflict with | Resolution |
|------|-------------|---------------|------------|
| **8080** | Coroot UI | `with-events-redpanda` (Redpanda Console) | No conflict — separate docker networks, examples run independently |
| **5000-5001** | Microservices | `production-ready`, `runn` | No conflict — separate docker networks |
| **4317-4318** | OTel Collector | `production-ready`, `runn` | No conflict — separate docker networks |
| **9000** | ClickHouse | — | Unique among examples |
| **3000** | — | `production-ready` (Grafana) | NOT used in o11y-coroot |

**Conclusion**: No conflicts. All examples use isolated docker networks and are not run simultaneously. If simultaneous execution is needed, port mapping can be shifted (e.g., `8081:8080` for Coroot).

---

## 5. Node Agent Decision

### EXCLUDE coroot-node-agent

**Rationale**:
1. **Docker Desktop incompatibility** — target audience of the examples uses macOS/Windows
2. **eBPF requires privileged mode** — elevated privileges are undesirable in examples
3. **OTLP is sufficient** — microservices are already instrumented via `@connectum/otel`, sending traces/metrics/logs over OTLP
4. **Coroot works without node-agent** — OTLP ingestion via built-in receiver or OTel Collector covers all demonstration needs

### What We Lose Without node-agent

- eBPF-based network traces (TCP connections between containers)
- Automatic container discovery
- System-level metrics (CPU, memory, disk, network per container)
- Container log discovery
- CPU profiling via Pyroscope

### What We Get Via OTLP

- Application-level distributed traces (HTTP/gRPC spans)
- Custom metrics (histograms, counters, gauges)
- Structured logs
- Service map based on trace data

**This is sufficient to demonstrate Connectum observability capabilities**.

---

## 6. Minimal Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Docker Network: o11y                         │
│                                                                     │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────────┐    │
│  │ order-service │     │  inventory-  │     │                  │    │
│  │   :5000       │     │   service    │     │    ClickHouse    │    │
│  │               │     │   :5001      │     │  :9000 (native)  │    │
│  └──────┬───────┘     └──────┬───────┘     │  :8123 (http)    │    │
│         │ OTLP/HTTP          │ OTLP/HTTP   └────────▲─────────┘    │
│         │                    │                      │              │
│         ▼                    ▼                      │              │
│  ┌─────────────────────────────────┐               │              │
│  │       OTel Collector            │               │              │
│  │   :4317 (gRPC) :4318 (HTTP)    │               │              │
│  │   batch → otlphttp/coroot      │               │              │
│  └──────────────┬──────────────────┘               │              │
│                 │ OTLP/HTTP                         │              │
│                 ▼                                   │              │
│  ┌──────────────────────────────────┐              │              │
│  │          Coroot                   │──────────────┘              │
│  │   :8080 (UI + API + OTLP)        │   native :9000              │
│  │   Project auto-configured         │                            │
│  └──────────────────────────────────┘                             │
└─────────────────────────────────────────────────────────────────────┘

Host ports exposed:
  - 8080  → Coroot UI (http://localhost:8080)
  - 5000  → order-service (gRPC/Connect)
  - 5001  → inventory-service (gRPC/Connect)
  - 4317  → OTel Collector gRPC (for external tools)
  - 4318  → OTel Collector HTTP (for external tools)
```

---

## 7. Key Configuration Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Metrics backend | ClickHouse (not Prometheus) | Coroot prioritizes CH; single backend for all telemetry |
| OTLP routing | Via OTel Collector | Compatible with production-ready, batch processing, extensibility |
| Node agent | Excluded | Docker Desktop incompatibility, OTLP is sufficient |
| Cluster agent | Excluded | Kubernetes-only |
| Coroot UI port | 8080 | Coroot default, no conflicts |
| ClickHouse version | 24.3 | Verified in official Coroot docker-compose |
| Docker network | Isolated `o11y` | Project standard — each example in its own network |

---

## 8. Example File Structure

```
examples/o11y-coroot/
├── docker-compose.yml              # All services: Coroot + CH + OTel + microservices
├── otel-collector-config.yaml      # OTel Collector → Coroot routing
├── clickhouse/
│   └── config.xml                  # ClickHouse optimizations (log disabling)
├── services/
│   ├── order-service/              # Symlink or copy from production-ready
│   └── inventory-service/          # Symlink or copy from production-ready
└── README.md                       # Documentation (technical-writer)
```

**Alternative to symlinks**: use `build.context: ../production-ready/services/order-service` to reference existing Dockerfiles directly without duplication.

---

## References

- [Coroot Documentation](https://docs.coroot.com/)
- [Coroot Architecture](https://docs.coroot.com/installation/architecture/)
- [Coroot Docker Compose (official)](https://github.com/coroot/coroot/blob/main/deploy/docker-compose.yaml)
- [ClickHouse Configuration](https://docs.coroot.com/configuration/clickhouse/)
- [coroot-node-agent Docker Desktop issue #54](https://github.com/coroot/coroot-node-agent/issues/54)
- [Monitoring Docker Homelab with Coroot](https://coroot.com/blog/monitoring-a-docker-homelab-with-coroot/)
- [OpenTelemetry for Go — Coroot](https://docs.coroot.com/tracing/opentelemetry-go/)
