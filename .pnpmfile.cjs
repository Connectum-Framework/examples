// .pnpmfile.cjs — Redirect @connectum/* to local tarballs from Connectum/pack/
//
// Usage, from an example directory:
//   pnpm install
//       — published npm versions; this hook is not loaded at all
//   export CONNECTUM_LOCAL=1 PNPM_CONFIG_PNPMFILE=../.pnpmfile.cjs
//   pnpm install && pnpm test
//       — local tarballs from pack/ (the path is relative to the example
//         directory: ../../.pnpmfile.cjs for o11y-coroot/service). Export both
//         variables for every pnpm command, not only for the install: before
//         `pnpm run` / `pnpm exec`, pnpm 12 checks the dependencies and, without
//         the hook, reinstalls the published versions. pnpm 12 reads only the
//         uppercase PNPM_CONFIG_PNPMFILE.
//   git checkout -- pnpm-lock.yaml && pnpm install --frozen-lockfile
//       — back to the published versions the committed lockfile pins (a plain
//         `pnpm install` re-resolves the ranges and can move them)
//
// No example links to this file. When an example loads a pnpmfile, pnpm records
// its checksum in pnpm-lock.yaml, and a hook that lives outside the example's
// Docker build context makes `pnpm install --frozen-lockfile` fail inside
// `docker build`. So the hook is opt-in: pnpm reads it only when
// PNPM_CONFIG_PNPMFILE names it.
//
// pack/ sits next to this repository's checkout and holds the tarballs that
// `pnpm pack` produces for the framework packages. When it has no tarball for a
// package the hook leaves that dependency on its published version silently, so
// check that `readlink -f node_modules/@connectum/core` points at a .tgz, after
// the tests as well as after the install.

"use strict";

const path = require("node:path");
const fs = require("node:fs");

const CONNECTUM_PACKAGES = [
  "core",
  "auth",
  "interceptors",
  "healthcheck",
  "protoc-gen-catalog",
  "reflection",
  "cli",
  "otel",
  "testing",
  "events",
  "events-nats",
  "events-kafka",
  "events-redis",
  "events-amqp",
];

// __dirname resolves to the real file location (examples/), not the symlink.
// So ../pack always resolves to Connectum/pack/.
const PACK_DIR = path.resolve(__dirname, "..", "pack");

/**
 * Find a tarball for a given @connectum package name.
 * Pattern: connectum-{name}-*.tgz (version-agnostic).
 */
function findTarball(name) {
  const prefix = `connectum-${name}-`;
  try {
    const files = fs.readdirSync(PACK_DIR);
    const match = files.find(
      (f) => f.startsWith(prefix) && f.endsWith(".tgz"),
    );
    if (match) {
      return path.join(PACK_DIR, match);
    }
  } catch {
    // pack/ directory does not exist — skip silently
  }
  return null;
}

function readPackage(pkg) {
  if (process.env.CONNECTUM_LOCAL !== "1") {
    return pkg;
  }

  for (const name of CONNECTUM_PACKAGES) {
    const scope = `@connectum/${name}`;

    if (pkg.dependencies && pkg.dependencies[scope]) {
      const tarball = findTarball(name);
      if (tarball) {
        pkg.dependencies[scope] = `file:${tarball}`;
      }
    }

    if (pkg.devDependencies && pkg.devDependencies[scope]) {
      const tarball = findTarball(name);
      if (tarball) {
        pkg.devDependencies[scope] = `file:${tarball}`;
      }
    }

    if (pkg.peerDependencies && pkg.peerDependencies[scope]) {
      const tarball = findTarball(name);
      if (tarball) {
        pkg.peerDependencies[scope] = `file:${tarball}`;
      }
    }
  }

  return pkg;
}

module.exports = {
  hooks: {
    readPackage,
  },
};
