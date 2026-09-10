# Effect Versioning & Dependency Pinning

> Learned the hard way during the `alchemy@beta.70 → beta.77` /
> `effect@4.0.0-beta.103 → 4.0.0-rc.112` upgrade. Effect's prerelease
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

### Fix: pin every `@effect/*` peer to the exact version

```jsonc
"overrides": {
  "@effect/platform-node-shared": "4.0.0-rc.112",
  "@effect/sql-d1": "4.0.0-rc.112",
  "@effect/sql-sqlite-do": "4.0.0-rc.112",
  "@effect/vitest": "4.0.0-rc.112"
}
```

After any `@effect/*` bump, **re-audit**: list what actually installed, not
what you asked for.

### ⚠️ `overrides` do NOT propagate to consumers

This is the part that ships and bites. **`overrides` apply only from the ROOT
`package.json` of the installing project** — npm, bun, and pnpm all ignore a
*dependency's* overrides. So a library can fix its own dev tree and still hand
consumers a broken dependency graph.

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

## Rule 3 — pin the peer range narrowly, and know why

This repo declares a deliberately tight range:

```jsonc
"peerDependencies": {
  "effect": ">=4.0.0-rc.112 <4.0.0-rc.113"
}
```

Not conservative-for-its-own-sake: `rc.113` renamed the `Config` accessors to
`Config.String`, and **`Config.String` does not exist on rc.112** (verified:
`Config.string` is a function, `Config.String` is `undefined`). Alchemy beta.77
requires rc.112 and calls the lowercase form ~119 times, so the two versions are
mutually incompatible in both directions.

**A migration cannot be staged across such a rename.** Alchemy beta.70 itself
called `Schema.TaggedErrorClass`, which is *removed* in rc.112 — so old-alchemy
cannot run on new-effect, and new-alchemy cannot run on old-effect. Effect and
Alchemy must move in **one** commit.

## Rule 4 — verify renames at RUNTIME, not just in `.d.ts`

Type declarations alone did not prove the `Config` rename. This did:

```bash
npm pack effect@4.0.0-rc.112 && tar xzf effect-4.0.0-rc.112.tgz
node -e "const C=require('./package/dist/Config.js');
  console.log('string:', typeof C.string, '| String:', typeof C.String)"
# rc.112 → string: function | String: undefined
# rc.113 → string: undefined | String: function
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
6. Install, then **re-audit installed `@effect/*` versions** (Rule 1) and add
   `overrides` for any that drifted.
7. Count tests before and after. A *drop* in total tests means load-time
   failures, not passing code.
