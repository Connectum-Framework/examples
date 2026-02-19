# =============================================================================
# Stage 1: Install dependencies
# =============================================================================
FROM node:25-slim AS deps

# Install pnpm
RUN npm install -g pnpm

WORKDIR /app

# Copy package manifests (build context = Connectum/ root)
COPY examples/runn/package.json examples/runn/pnpm-lock.yaml ./

# Copy .pnpmfile.cjs hook (resolves @connectum/* to local tarballs)
COPY examples/.pnpmfile.cjs ./

# Copy local tarballs from pack/ (hook references ../pack relative to .pnpmfile.cjs)
# Since .pnpmfile.cjs is at /app/.pnpmfile.cjs, ../pack resolves to /pack
COPY pack/ /pack/

# Set CONNECTUM_LOCAL=1 so the hook activates
ENV CONNECTUM_LOCAL=1

# Install production dependencies using the hook to redirect @connectum/* to /pack/*.tgz
RUN pnpm install --prod

# =============================================================================
# Stage 2: Production runtime
# =============================================================================
FROM node:25-slim AS runtime

# Install curl for HEALTHCHECK and openssl for TLS cert generation
RUN apt-get update && apt-get install -y --no-install-recommends curl openssl \
    && rm -rf /var/lib/apt/lists/*

# Generate self-signed TLS certificates at build time
RUN mkdir -p /app/certs && openssl req -x509 -newkey rsa:2048 \
    -keyout /app/certs/server.key -out /app/certs/server.crt \
    -days 365 -nodes -subj '/CN=server-tls' \
    -addext 'subjectAltName=DNS:server-tls,DNS:localhost'

# Run as non-root user
RUN groupadd -r connectum && useradd -r -g connectum -m connectum

WORKDIR /app

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source (native TypeScript -- no build needed)
COPY examples/runn/package.json ./
COPY examples/runn/src/ ./src/
COPY examples/runn/gen/ ./gen/

# Set ownership (includes certs)
RUN chown -R connectum:connectum /app

USER connectum

# Environment defaults
ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

# Health check via HTTP endpoint from @connectum/healthcheck
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=5 \
    CMD ["sh", "-c", "curl -fk https://localhost:${PORT:-5000}/healthz 2>/dev/null || curl -f --http2-prior-knowledge http://localhost:${PORT:-5000}/healthz 2>/dev/null || curl -f http://localhost:${PORT:-5000}/healthz 2>/dev/null || exit 1"]

# Start with native TypeScript support (Node.js 25.2.0+ stable type stripping)
CMD ["node", "src/index.ts"]
