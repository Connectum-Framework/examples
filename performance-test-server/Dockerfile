# =============================================================================
# Performance Test Server — Docker image for k6 benchmarking
# =============================================================================
FROM node:25-slim AS deps

# pnpm is pinned to the version that writes the committed pnpm-lock.yaml, so the
# frozen install reads the lockfile exactly as it was produced.
RUN npm install -g pnpm@12.4.1

WORKDIR /app

# pnpm-workspace.yaml holds the dependency overrides and allowBuilds approvals the
# lockfile was resolved with; without it the frozen install rejects the lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# =============================================================================
# Generate protobuf TypeScript code from .proto sources
# =============================================================================
FROM node:25-slim AS proto

RUN npm install -g pnpm@12.4.1

WORKDIR /app

# Same pinned pnpm and workspace settings as the deps stage; the approval for the
# @bufbuild/buf install script lives in pnpm-workspace.yaml, and buf generate
# below needs the binary that script installs.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY proto/ ./proto/
COPY buf.yaml buf.gen.yaml ./

RUN pnpm build:proto

# =============================================================================
# Generate self-signed TLS certificates for h2 (ALPN) support
# =============================================================================
FROM node:25-slim AS certs

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /certs && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout /certs/server.key -out /certs/server.crt -days 365 -nodes \
    -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,DNS:server"

# =============================================================================
# Production runtime
# =============================================================================
FROM node:25-slim AS runtime

RUN groupadd -r connectum && useradd -r -g connectum -d /app connectum

WORKDIR /app

# Copy production node_modules from deps stage
COPY --from=deps --chown=connectum:connectum /app/node_modules ./node_modules

# Copy TLS certificates
COPY --from=certs --chown=connectum:connectum /certs /app/certs

# Copy generated protobuf code from proto stage
COPY --from=proto --chown=connectum:connectum /app/gen ./gen

# Copy application source (native TypeScript — no build needed)
COPY --chown=connectum:connectum package.json ./
COPY --chown=connectum:connectum src/ ./src/

USER connectum

ENV NODE_ENV=production
ENV TLS_DIR=/app/certs

# Ports: 8080 (full chain), 8081 (baseline), 8082 (validation),
#        8083 (logger), 8084 (otel no-op), 8085 (otel real OTLP export —
#        only bound when OTEL_EXPORT_ENABLED=1)
EXPOSE 8080 8081 8082 8083 8084 8085

CMD ["node", "src/index.ts"]
