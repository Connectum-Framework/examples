# =============================================================================
# Stage 1: Install dependencies
# =============================================================================
FROM node:25-slim AS deps

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package manifests for dependency caching
COPY package.json pnpm-lock.yaml ./

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# =============================================================================
# Stage 2: Production runtime
# =============================================================================
FROM node:25-slim AS runtime

# Install curl for HEALTHCHECK (minimal addition)
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Run as non-root user
RUN groupadd -r connectum && useradd -r -g connectum -m connectum

WORKDIR /app

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source (native TypeScript -- no build needed)
COPY package.json ./
COPY src/ ./src/
COPY gen/ ./gen/

# Set ownership
RUN chown -R connectum:connectum /app

USER connectum

# Environment defaults
ENV NODE_ENV=production
ENV PORT=5000
ENV LOG_FORMAT=json
ENV LOG_LEVEL=info
ENV HTTP_HEALTH_ENABLED=true
ENV GRACEFUL_SHUTDOWN_ENABLED=true
ENV GRACEFUL_SHUTDOWN_TIMEOUT_MS=30000

EXPOSE 5000

# Health check via HTTP endpoint from @connectum/healthcheck
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:5000/healthz || exit 1

# Start with native TypeScript support (Node.js 25.2.0+ stable type stripping)
CMD ["node", "--experimental-strip-types", "src/index.ts"]
