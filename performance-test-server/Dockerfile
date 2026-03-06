# =============================================================================
# Performance Test Server — Docker image for k6 benchmarking
# =============================================================================
FROM node:25-slim AS base

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./

# =============================================================================
# Production dependencies
# =============================================================================
FROM base AS deps

RUN pnpm install --frozen-lockfile --prod

# =============================================================================
# Generate protobuf TypeScript code from .proto sources
# =============================================================================
FROM base AS proto

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
#        8083 (logger), 8084 (otel)
EXPOSE 8080 8081 8082 8083 8084

CMD ["node", "src/index.ts"]
