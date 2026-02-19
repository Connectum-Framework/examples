// .pnpmfile.cjs — Redirect @connectum/* to local tarballs from Connectum/pack/
//
// Usage:
//   pnpm install                          — uses published npm versions (no-op)
//   CONNECTUM_LOCAL=1 pnpm install        — uses local tarballs from pack/
//
// This file is committed to git. Symlinks in each example point here.
// The pack/ directory is populated by: cd connectum && pnpm run pack:all

"use strict";

const path = require("node:path");
const fs = require("node:fs");

const CONNECTUM_PACKAGES = [
  "core",
  "auth",
  "interceptors",
  "healthcheck",
  "reflection",
  "cli",
  "otel",
  "testing",
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
