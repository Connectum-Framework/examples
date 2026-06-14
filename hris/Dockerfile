# One image, every role. The role is chosen at runtime by the SERVICES env
# (see docker-compose.yml); the entrypoint is always src/index.ts.
FROM node:25-slim AS deps
RUN npm install -g pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:25-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends wget && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY gen/ ./gen/
ENV NODE_ENV=production
EXPOSE 5000 5001 5002 5003
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
    CMD wget -q --spider http://localhost:${PORT:-5000}/healthz || exit 1
CMD ["node", "src/index.ts"]
