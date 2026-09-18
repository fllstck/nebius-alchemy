# Effect Versioning & Dependency Pinning

> Learned the hard way during the `alchemy@beta.70 → beta.77` /
> `effect@4.0.0-beta.103 → 4.0.0-rc.112` upgrade, and re-confirmed by the
> `beta.77 → beta.79` / `effect rc.112 → rc.115` bump. Effect's prerelease
> versioning behaves counter-intuitively in two ways that cost real debugging
> time.

## Rule 1 — a caret range on a prerelease resolves UPWARD

`^4.0.0-rc.112` does **not** mean "exactly rc.112". It means
`>=4.0.0-rc.112 <5.0.0`, and prereleases sharing the same
`[major, minor, patch]` tuple are compared numerically — so it happily
resolves to `rc.113`, `rc.114`, …

This bites hardest through **transitive** dependencies that you never wrote:

```
@effect/platform-node@4.0.0-rc.112
  └─ "@effect/platform-node-shared": "^4.0.0-rc.112"
       └─ resolves to 4.0.0-rc.113   ← peers on effect ^4.0.0-rc.113
```

### The failure is disguised

rc.113 renamed `Config.string` → `Config.String` and removed several
`FileSystem` size helpers. The resulting error was **not** a version error:

```
error: Cannot find module 'effect/ByteSize' from
  .../node_modules/@effect/platform-node-shared/dist/NodeFileSystem.js
```

That reads like a broken install or a missing file. It is a **version**
problem: the newer shared package imports a subpath that does not exist in the
older `effect` you pinned. Test files then die at *load* time, so whole files
report zero tests and the suite silently shrinks (535 tests → 140) instead of
failing loudly.

### Status: dormant since `effect@4.0.0-rc.113` — and still structural

From rc.113 on, the whole `@effect/*` family ships on the **same release**, so
the internal carets cannot point at a different `rc` than the one you installed.
Verified on rc.115: all nine installed `@effect/*` packages resolve to
`4.0.0-rc.115`, with no nested duplicates and no `overrides` block anywhere in
this repo.

Do not read that as *fixed*. The carets are unchanged; the drift is absent only
because the pinned `rc` currently **is** the newest. Publish a newer `rc` and
`^4.0.0-rc.115` resolves up to it again. The mitigation stays the same and it is
cheap: pin `effect` exactly, and re-audit after every bump (snippet below).

### ⚠️ `overrides` do NOT propagate to consumers

This is the part that ships and bites. **`overrides` apply only from the ROOT
`package.json` of the installing project** — npm, bun, and pnpm all ignore a
*dependency's* overrides. So a library can fix its own dev tree and still hand
consumers a broken dependency graph — which is why the 0.7.0 release was **held**
rather than shipped with an "add this block" note, and why that note was deleted
once a coherent release existed (rc.113+).

Consequence for a published package: if a transitive peer needs pinning, every
consumer must add the same block themselves. There is no way to ship it.

The failure mode is deceptive and multi-layered:

| Signal | What it actually tells you |
| --- | --- |
| `npm warn ERESOLVE overriding peer dependency` | install **proceeded anyway** — not a failure |
| install exits **0** | ✅ nothing — the tree is still broken |
| `tsc --noEmit` **passes** | ✅ nothing — `skipLibCheck` never resolves runtime imports |
| `import('the-package')` | ❌ **fails**: `Cannot find module 'effect/ByteSize'` |

Only the last one catches it. **Verify consumer installs by importing, not just
by typechecking** — add a runtime import to any consumer smoke test, because a
typecheck-first pipeline will happily ship an unimportable package.

Also check the fix is genuinely available: if no released version of the
upstream package pins its range correctly, there is **no override-free
combination**, and the only honest options are documenting the workaround or not
releasing. Confirm by listing versions — `dist-tags.latest` may be the newest
there is.

### How others in the ecosystem handle this

Researched 2026-09-10. **Nobody has a dependency-declaration-only fix** — the same
conclusion Prisma reached independently (*"No dependency declaration can prevent
this"*). There are four working approaches, and their trade-offs matter:

| Approach | Who | Works for consumers? |
| --- | --- | --- |
| **Exact pins** (+ compat table) | sibling alchemy providers (`railway-`, `vercel-alchemy-provider`) | ✅ for npm; bun ignores peer ranges |
| **Resolution check in CI** | Prisma (`check:npm-effect-resolution`) | ✅ catches it pre-release |
| **Runtime guard** (fail fast) | Prisma | ✅ clear failure, no fix |
| **Bundle the runtime** | OpenCode | ❌ unavailable to raw-TS source packages |
| Move to a coherent release | alchemy itself | ✅ but requires upstream |

**Exact pins are the sibling-provider convention.** `railway-alchemy-provider`
and `vercel-alchemy-provider` both say *"Alchemy v2 and Effect v4 are currently
beta dependencies, so compatible versions are pinned exactly"* — no carets in
dependencies *or* peers, plus a README compatibility table. A range looks
tolerant but cannot be satisfied strictly against prereleases, so consumers
drift silently.

**Declaring the drifting package as an exact peer fixes npm but not bun.**
Verified both ways on the same tarball at rc.112:

```jsonc
"peerDependencies": { "@effect/platform-node-shared": "4.0.0-rc.112" }
// npm → resolves 4.0.0-rc.112, imports fine, NO consumer overrides needed
// bun → ignores it, resolves 4.0.0-rc.113, crashes on import
```

Since rc.113 **both** installers resolve correctly with no consumer
configuration at all — asserted in CI for npm *and* bun against the packed
tarball. The exact peer is **kept** anyway: it is free for npm, and it makes the
next drift fail loudly instead of silently.

npm satisfies the exact peer *and* the transitive `^4.0.0-rc.112` from the same
version, so it dedupes correctly. Bun does not enforce peer ranges at all.

**A direct exact `dependency` is worse than useless** — bun installs a second
nested copy (`rc.112` beside the hoisted `rc.113`) instead of deduping, so the
crashing copy survives *and* you ship a duplicate. Verified.

**Practical ordering:** ship an exact peer (free win for npm), add a
runtime-import check to CI that runs **both** installers, and get onto a coherent
Effect release as soon as one exists. If none exists yet, hold the release rather
than documenting a workaround the consumer cannot inherit — and only ever state a
workaround requirement in the README while it is actually true.

### Don't assume a runtime/branch lets you dodge it

When a broken dependency loads behind a runtime check, it is tempting to
conclude it is avoidable — "it only fails on Node, so use Bun". **Verify that
claim before repeating it.**

Alchemy's `Util/PlatformServices.ts` is exactly this shape:

```ts
const isBun = typeof Bun !== "undefined";
// bun  -> import("@effect/platform-bun/BunServices")
// node -> import("@effect/platform-node/NodeServices")
```

The `bun` branch still pulls in `@effect/platform-node-shared`, because
**`@effect/platform-bun` is layered on top of it** and statically imports it from
13 of its own modules (`BunFileSystem`, `BunCrypto`, `BunChildProcessSpawner`, …).
The failing consumer test crashed under `bun`, not `node` — the opposite of what
the branch implies.

Generalised: when you find a conditional load, follow **both** branches to their
real dependency trees before claiming one is safe. "Use runtime X" is only a
workaround if X's package genuinely does not depend on the broken thing — check
its `package.json`, not its name. And beware attributing a failure to the one
call site you happened to read: `alchemy` also *statically* imports
`@effect/platform-node` in ~10 unrelated modules, which a barrel import pulls in
regardless of any branch.

For a consumer-facing package, document the block in the install section and
mark it **required**, not optional. A note that says "this package ships an
`overrides` block" is actively misleading if you are the dependency rather than
the app.

```bash
find node_modules -maxdepth 4 -path "*@effect/*/package.json" \
  | while read f; do node -e "const p=require('./$f'); \
    if((p.name||'').startsWith('@effect/')) console.log(p.name, p.version)"; done | sort -u
```

Every `@effect/*` runtime package should sit on **one** version.

## Rule 2 — an optional peer dependency is never upgraded for you

`@effect/platform-bun` sat at `4.0.0-beta.103` (peering on
`effect ^4.0.0-beta.103`) while everything else moved to rc.112 — because it is
an **optional peer** of alchemy, so it is neither a direct dependency nor
strictly required, and no installer will bump it.

If code imports it (`import { BunServices } from '@effect/platform-bun'`), pin
it as a **direct devDependency** at the version you actually need:

```jsonc
"devDependencies": { "@effect/platform-bun": "4.0.0-rc.112" }
```

Generalise: anything you `import` should be a declared dependency, even when it
arrives transitively via a peer.

## Rule 3 — pin peer versions EXACTLY, and know why

This repo pins exact versions in `peerDependencies` — no carets, no ranges:

```jsonc
"peerDependencies": {
  "effect": "4.0.0-rc.115",
  "@effect/platform-bun": "4.0.0-rc.115",
  "@effect/platform-node": "4.0.0-rc.115",
  "@effect/platform-node-shared": "4.0.0-rc.115"
}
```

Three reasons, in order of how much they matter:

1. **An exact peer on the *drifting* package is the only declaration that fixes
   npm consumers.** `@effect/platform-node-shared` is not a peer of ours by
   nature — it is declared purely so npm resolves it to the version the rest of
   the constellation needs. See the table above; it does nothing for bun. (Since
   rc.113 this is belt-and-braces rather than load-bearing, but it earns its keep
   the next time a caret drifts.)
2. **Ranges on prereleases are a lie.** `>=4.0.0-rc.112 <4.0.0-rc.113` reads as
tolerant but cannot be satisfied strictly, and consumers silently drift out of
it. An exact pin is a *contract*; the sibling alchemy providers do the same.
3. **Each alchemy beta requires one specific Effect release.** `rc.113` renamed
   the `Config` accessors to `Config.String`, and **`Config.String` does not
   exist on rc.112** (verified at runtime: `Config.string` is a function,
   `Config.String` is `undefined`). Alchemy beta.77 required rc.112 and called
   the lowercase form ~119 times, so those two were mutually incompatible in
   both directions. At rc.115 it is capitalized on both sides — and the same
   trap catches *our* code: the 55 `Config.string(` call sites had to be renamed
   in the same commit as the bump, or the package would have thrown at import.

**A migration cannot be staged across such a rename.** Alchemy beta.70 itself
called `Schema.TaggedErrorClass`, which is *removed* in rc.112 — so old-alchemy
cannot run on new-effect, and new-alchemy cannot run on old-effect. Effect and
Alchemy must move in **one** commit.

## Rule 4 — verify renames at RUNTIME, not just in `.d.ts`

Type declarations alone did not prove the `Config` rename. This did:

```bash
npm pack effect@4.0.0-rc.115 && tar xzf effect-4.0.0-rc.115.tgz
node -e "const C=require('./package/dist/Config.js');
  console.log('string:', typeof C.string, '| String:', typeof C.String)"
# rc.112  → string: function  | String: undefined
# rc.113+ → string: undefined | String: function
```

Diffing the two tarballs' **exported symbols** is what produced a reliable
breakage inventory (e.g. `TaggedErrorClass` → `TaggedError`: 0 occurrences of
the old name remaining). Grepping the installed `node_modules` of the *target*
version is faster and more trustworthy than reading changelogs.

## Checklist for the next Effect/Alchemy bump

1. `npm view effect dist-tags` and `npm view alchemy dist-tags` — note that
   `latest` and `next` can point at different betas.
2. Check the new alchemy's `peerDependencies` for the required `effect` range.
3. `npm pack` both old and new, and diff **runtime** exports of every module you
   import — not just types.
4. **Diff the CLI surface too** — run `<cli> --help` and check each subcommand
   you reference in docs, error messages, or examples. A renamed command
   (`alchemy login` → `alchemy profile`) throws no type error and fails no test;
   it only breaks users. Grep the repo for every command string you emit.
5. Grep the new alchemy source for APIs you rely on that were removed in the
   target Effect (`Config.string`, `FileSystem.Size`, `TaggedErrorClass`, …).
6. Install, then **re-audit installed `@effect/*` versions** (Rule 1). They must
   all be one version, with no nested duplicates. Add `overrides` only to unblock
   your own dev tree — never as the shipped fix, because consumers cannot inherit
   it.
7. Count tests before and after. A *drop* in total tests means load-time
   failures, not passing code.
8. **Pack the tarball and import it from a scratch consumer, with both `npm` and
   `bun`, and no `overrides`.** This is the only check that exercises real
   resolution — a typecheck and the unit suite both pass on a broken tree.
   `.github/smoke/consumer.sh` does exactly this; run it before releasing.
