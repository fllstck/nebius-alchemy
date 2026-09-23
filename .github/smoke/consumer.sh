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
#
# `pinOf` refuses to hand back `undefined`. Deriving a pin from a field that MOVED is invisible
# otherwise: when 0.9.1 turned `alchemy` into a peer, `dependencies.alchemy` started evaluating to
# `undefined`, `node -p` printed the string `undefined`, and the job installed `alchemy@undefined` —
# failing with `ETARGET` in a CI run, naming neither the field nor the file (2026-09-23).
pinOf() {
  local expression="$1" label="$2" value
  value="$(node -p "$expression")"
  if [ -z "$value" ] || [ "$value" = "undefined" ]; then
    # `>&2`: inside `$( … )` anything on stdout is captured as the value, so the message would
    # vanish exactly when it is needed.
    echo "::error::could not read the $label pin from package.json (got '$value') — the field moved or was removed. Fix the derivation in .github/smoke/consumer.sh." >&2
    exit 1
  fi
  printf '%s' "$value"
}

PIN="$(pinOf "require('$ROOT/package.json').peerDependencies.effect" 'effect')"
# The README's install line names alchemy explicitly (it is a peer since 0.9.1, so this also proves
# the peer is satisfiable at the exact beta). Omitting alchemy from this test is what hid a real npm
# failure at 0.8.1: as a *root* dependency alchemy's optional frontend chain competes with the
# typescript peer, while as a transitive one it is skipped — so the two commands resolve differently.
ALCHEMY_PIN="$(pinOf "require('$ROOT/package.json').peerDependencies.alchemy" 'alchemy (peer)')"
BUN_PEER="$(pinOf "require('$ROOT/package.json').peerDependencies['@effect/platform-bun']" '@effect/platform-bun')"
NODE_PEER="$(pinOf "require('$ROOT/package.json').peerDependencies['@effect/platform-node']" '@effect/platform-node')"
# 0.9.1 dropped the `typescript` peer: a compiler *range* as a peer makes npm fail against alchemy's
# optional TypeScript-5 chains (`octane`, `@xata.io`) — the 0.8.0 failure mode, re-triggered by alchemy
# becoming a root peer. The compiler is consumer-provided, so pin the documented line for this check.
TS_PEER=">=6 <8"

rm -rf "$DIR"
mkdir -p "$DIR"
cd "$DIR"
printf '{"name":"consumer","version":"1.0.0","private":true}' > package.json

echo "::group::install ($INSTALLER, no overrides)"
if [ "$INSTALLER" = "npm" ]; then
  # EXACTLY the README's `bun add` line (which never names `typescript`): the
  # point of this job is to test the documented install, and an explicit
  # `typescript@…` argument is what used to hide a real `npm install` failure —
  # a root pin satisfies the tooling peer and masks the ERESOLVE against
  # alchemy's optional `typescript@^6` chain.
  npm install "$TARBALL" "alchemy@$ALCHEMY_PIN" "effect@$PIN" \
    "@effect/platform-bun@$BUN_PEER" "@effect/platform-node@$NODE_PEER"
else
  # bun does not enforce peer ranges, so the peers the README's `bun add` line
  # lists explicitly are what actually put them in the tree. No `overrides`:
  # if a drift ever returns, that is exactly what this assertion must catch.
  bun add "$TARBALL" "alchemy@$ALCHEMY_PIN" "effect@$PIN" \
    "@effect/platform-bun@$BUN_PEER" "@effect/platform-node@$NODE_PEER"
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
# npm auto-installs the `typescript` peer (a range), so the tree already has a
# compiler — and that is the one we use, so the low end of the supported range is
# what gets exercised. bun ignores peer ranges, so install it as tooling only
# (after the assertions above, which must see the documented install).
if [ ! -x ./node_modules/.bin/tsc ]; then
  bun add --dev "typescript@$TS_PEER"
fi
./node_modules/.bin/tsc --noEmit
echo "✓ tsc --noEmit clean (typescript $(node -p "require('./node_modules/typescript/package.json').version"))"

# The check that actually catches a broken transitive dependency: load it.
# It fails at import, not at typecheck.
bun -e "await import('@fllstck/nebius-alchemy'); console.log('✓ import @fllstck/nebius-alchemy OK')"
bun -e "await import('alchemy'); console.log('✓ import alchemy OK')"
