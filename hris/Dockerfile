# One image, every role. The RPC role is chosen at runtime by the SERVICES env
# (see docker-compose.yml); the default entrypoint is src/index.ts. The Temporal
# worker reuses this same image with `command: ["node", "src/worker.ts"]`.
FROM node:25-slim AS deps
# pnpm is pinned to the version that writes the committed pnpm-lock.yaml, so the
# frozen install below reads the lockfile exactly as it was produced.
RUN npm install -g pnpm@12.4.1
WORKDIR /app
# pnpm-workspace.yaml carries the allowBuilds approvals (@swc/core compiles the
# Temporal workflow bundle in the worker; protobufjs is a Temporal gRPC dep) and
# the dependency overrides the lockfile records, so it MUST be present: without
# it the build scripts are blocked and the frozen install rejects the lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The image installs exactly what the committed lockfile pins: two builds of the
# same commit get the same dependency tree, and a dependency bump shows up as a
# reviewed lockfile change instead of an invisible drift inside the image.
RUN pnpm install --frozen-lockfile --prod

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
