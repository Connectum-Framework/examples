# One image, every role. The role is chosen at runtime by the SERVICES env
# (see k8s/); the entrypoint is always src/index.ts. engines.node is >=25.2.0,
# so we run TypeScript directly with `node src/index.ts` (native type stripping)
# — no build step, no --experimental flags.

# ── deps: install production node_modules ───────────────────────────────────
FROM node:25-slim AS deps
RUN npm install -g pnpm
WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
# No lockfile is committed for this flagship example (matches getting-started /
# hris): pnpm resolves @connectum/* and other deps from the caret (^) ranges in
# package.json, so the image is example-grade, not bit-reproducible. Production
# services should commit pnpm-lock.yaml and use `pnpm install --frozen-lockfile`
# (the secondary examples model this).
RUN pnpm install --prod

# ── runtime: copy deps + source + generated proto code ──────────────────────
FROM node:25-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends wget && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY gen/ ./gen/
ENV NODE_ENV=production
# Default role: monolith. Kubernetes overrides SERVICES/*_ADDR per Deployment.
EXPOSE 5000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
    CMD wget -q --spider http://localhost:${PORT:-5000}/healthz || exit 1
# Run as the built-in non-root `node` user.
USER node
CMD ["node", "src/index.ts"]
