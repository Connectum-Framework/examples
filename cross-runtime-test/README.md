# cross-runtime-test

Cross-runtime smoke test suite for compiled @connectum/* packages.

Verifies that the compiled (tsup) distribution of @connectum packages works correctly on different JavaScript runtimes.

## Supported Runtimes

- **Node.js** >= 22.6.0 (for type stripping in test source code)
- **Bun** (planned)

## Test Coverage

| Test | Description |
|------|-------------|
| `server.test.ts` | Server lifecycle: start, running state, address, stop |
| `grpc.test.ts` | gRPC calls: SayHello, SayGoodbye via ConnectRPC client |
| `healthcheck.test.ts` | HTTP health check endpoints: /healthz, /readyz |
| `reflection.test.ts` | Server reflection protocol registration |

## Quick Start

After publishing compiled packages to npm:

```bash
pnpm install
pnpm build:proto
pnpm test
```

## Testing with Local Tarballs

To test against locally compiled packages (pre-publish verification):

```bash
# 1. Build packages in the framework repo
cd /path/to/connectum
pnpm build

# 2. Pack tarballs
for pkg in core interceptors healthcheck reflection; do
  cd packages/$pkg && pnpm pack && cd ../..
done

# 3. Update package.json dependencies AND add pnpm overrides
#    Both dependencies and overrides must use file: protocol pointing to tarballs.
#    Overrides are required because @connectum/* packages have peer dependencies
#    on each other, and pnpm would resolve those to the npm registry version
#    (which may not have compiled dist/).
#
#    Example package.json changes:
#    "dependencies": {
#      "@connectum/core": "file:/path/to/connectum-core-X.Y.Z.tgz",
#      ...
#    },
#    "pnpm": {
#      "overrides": {
#        "@connectum/core": "file:/path/to/connectum-core-X.Y.Z.tgz",
#        ...
#      }
#    }

# 4. Clean install (important: prune store if previously installed from npm)
pnpm store prune
rm -rf node_modules pnpm-lock.yaml
pnpm install

# 5. Run tests
pnpm test

# 6. Cleanup: revert package.json, delete tarballs
```

## Package Versions

Currently configured for `1.0.0-rc.3`. Update versions in `package.json` after publishing new compiled releases.

## Important Notes

- The current `1.0.0-rc.3` on npm publishes raw `.ts` source files, which Node.js cannot type-strip from `node_modules`. Tests will only pass with compiled tarballs or a future npm release that includes `dist/`.
- Each test creates its own server on port 0 (random) and uses `createHealthcheckManager()` to avoid shared state between tests.
- Health check tests use raw HTTP/2 client (`node:http2`) since the server runs on HTTP/2 plaintext.
