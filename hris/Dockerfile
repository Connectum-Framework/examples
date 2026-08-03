# One image, every role. The RPC role is chosen at runtime by the SERVICES env
# (see docker-compose.yml); the default entrypoint is src/index.ts. The Temporal
# worker reuses this same image with `command: ["node", "src/worker.ts"]`.
FROM node:25-slim AS deps
RUN npm install -g pnpm
WORKDIR /app
# pnpm-workspace.yaml carries the allowBuilds approvals (@swc/core compiles the
# Temporal workflow bundle in the worker; protobufjs is a Temporal gRPC dep), so
# it MUST be present for `pnpm install` to run those build scripts.
COPY package.json pnpm-workspace.yaml ./
# No lockfile is committed for this flagship example (matches getting-started /
# car-sharing): pnpm resolves @connectum/* and other deps from the caret (^)
# ranges in package.json, so the image is example-grade, not bit-reproducible.
# Production services should commit pnpm-lock.yaml and use
# `pnpm install --frozen-lockfile` (the secondary examples model this).
RUN pnpm install --prod

FROM node:25-slim AS runtime
# curl, not wget: these services run plaintext h2c (`allowHTTP1: false`), and
# wget speaks HTTP/1.1 only. Against an h2c listener `wget --spider` gets an
# empty status line yet still exits 0 -- it would report a dead or NOT_SERVING
# service as healthy. curl --http2-prior-knowledge reads the real response.
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY gen/ ./gen/
ENV NODE_ENV=production
EXPOSE 5000 5001 5002 5003 5004 5005
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
    CMD curl -fsS --http2-prior-knowledge http://localhost:${PORT:-5000}/healthz || exit 1
# Run as the built-in non-root `node` user.
USER node
CMD ["node", "src/index.ts"]
