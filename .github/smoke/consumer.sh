#!/usr/bin/env bash
# Consumer smoke helper — installs the packed tarball into a throwaway project
# exactly the way README.md documents, then proves the package *loads*.
#
# Why this exists: `tsc` with `skipLibCheck` never resolves runtime imports, so a
# typecheck-only smoke test structurally cannot catch a broken transitive
# dependency. The failure that motivated it was a prerelease caret
# (`^4.0.0-rc.112`) drifting `@effect/platform-node-shared` to `rc.113`, which
# imports `effect/ByteSize` — a subpath absent from the `effect@4.0.0-rc.112`
# that alchemy beta.77 required. The install exited 0 and `tsc` passed; only an
# actual `import` failed. See `agent-patterns/effect-versioning.md`.
#
# Since the `effect@4.0.0-rc.115` migration the whole `@effect/*` family moves as
# a single release, so no consumer needs an `overrides` block — for npm *or* bun.
# That is the claim this script asserts: both installers, no consumer config.
#
# Usage: consumer.sh <npm|bun> <dir> <tarball>
set -euo pipefail

INSTALLER="${1:?usage: consumer.sh <npm|bun> <dir> <tarball>}"
DIR="${2:?}"
TARBALL="${3:?}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Resolve the tarball to an absolute path: we `cd` into the scratch project
# before installing, so a relative path from the caller would not survive.
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"

# Pins are read from package.json rather than hardcoded, so a version bump can
# never leave this job asserting a stale version.
PIN="$(node -p "require('$ROOT/package.json').peerDependencies.effect")"
BUN_PEER="$(node -p "require('$ROOT/package.json').peerDependencies['@effect/platform-bun']")"
NODE_PEER="$(node -p "require('$ROOT/package.json').peerDependencies['@effect/platform-node']")"
TS_PEER="$(node -p "require('$ROOT/package.json').peerDependencies.typescript")"

rm -rf "$DIR"
mkdir -p "$DIR"
cd "$DIR"
printf '{"name":"consumer","version":"1.0.0","private":true}' > package.json

echo "::group::install ($INSTALLER, no overrides)"
if [ "$INSTALLER" = "npm" ]; then
  npm install "$TARBALL" "effect@$PIN" "@effect/platform-bun@$BUN_PEER" \
    "@effect/platform-node@$NODE_PEER" "typescript@$TS_PEER"
else
  # bun does not enforce peer ranges, so the peers the README's `bun add` line
  # lists explicitly are what actually put them in the tree. No `overrides`:
  # if a drift ever returns, that is exactly what this assertion must catch.
  bun add "$TARBALL" "effect@$PIN" "@effect/platform-bun@$BUN_PEER" \
    "@effect/platform-node@$NODE_PEER" "typescript@$TS_PEER"
fi
echo "::endgroup::"

# Resolution check. The failure mode here is a *silent* version drift, and a
# successful install says nothing about which version was picked — so assert the
# exact version explicitly instead of trusting the installer's exit code.
RESOLVED="$(node -p "require('./node_modules/@effect/platform-node-shared/package.json').version")"
if [ "$RESOLVED" != "$PIN" ]; then
  echo "::error::@effect/platform-node-shared resolved to $RESOLVED, expected the pinned $PIN (consumer overrides must not be required)"
  exit 1
fi
echo "✓ @effect/platform-node-shared resolved to $RESOLVED with no consumer overrides"

# Compile the README quick-start. Necessary but NOT sufficient — with
# `skipLibCheck` this never resolves the runtime imports.
cp "$ROOT/.github/smoke/smoke.ts" .
cp "$ROOT/.github/smoke/tsconfig.json" .
./node_modules/.bin/tsc --noEmit
echo "✓ tsc --noEmit clean"

# The check that actually catches a broken transitive dependency: load it.
# It fails at import, not at typecheck.
bun -e "await import('@fllstck/nebius-alchemy'); console.log('✓ import @fllstck/nebius-alchemy OK')"
bun -e "await import('alchemy'); console.log('✓ import alchemy OK')"
