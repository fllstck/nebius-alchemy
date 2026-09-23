# Release & Publish

> Learned during the 0.7.0 release (2026-09-18). Every item below is a trap that
> either corrupted the published artifact or made the release silently skip.

## `conventional-changelog -s` PREPENDS — it does not replace

`bun run changelog` adds a top section for the current `package.json` version. If
a section for that version already exists it is **left in place**, so you end up
with two:

```
# [0.7.0](…) (2026-09-18)   ← newly generated
…
# [0.7.0](…) (2026-09-10)   ← stale, still there
```

**Delete the stale section first** (everything above the next release heading),
then generate. Test the generator on a copy before trusting it in a release
commit — that is how this was found:

```bash
cp CHANGELOG.md /tmp/CL.test.md
./node_modules/.bin/conventional-changelog -p angular -i /tmp/CL.test.md -s
grep -c '^# \[0.7.0\]' /tmp/CL.test.md    # must be 1
```

## Commit footers leak VERBATIM into published notes

`BREAKING CHANGE:` footers are rendered into `### BREAKING CHANGES` as-is. Two
kinds of junk shipped into the 0.7.0 notes this way:

- **Release-process narration.** A footer ended with *"Verified: bun run check
  exit 0; bun test 530 pass … Real-infra integration tier still to re-run before
  publishing 0.7.0 (blocked on credentials)."* — stale by publish time, and
  meaningless to a consumer.
- **Tool trailers.** A commit from another agent had `model: deepseek/deepseek-flash`
  after its footer, and that line was published as part of the entry.

Keep footers to *what changed* and *what a consumer must do*. No verification
logs, no test counts, no timings, no tool/`model:` trailers in a commit body that
follows a footer.

## A breaking change with no footer is invisible to the tooling

`refactor(compute): scope hosted instance children under logical id` changed
resource **FQNs** — resource identity in alchemy state — so existing deployments
recreate those children instead of adopting them. Nothing flagged it: the commit
had no `BREAKING CHANGE:` footer.

Before tagging, scan the range and then read the diff for the classes the scanner
cannot see:

```bash
git log --format='%h %s' v0.6.0..HEAD | grep -E '^\w+ \w+(\(|)!:'   # explicitly marked
```

Renames, re-scoping, and removals are the ones to check by hand. If `main` is
already pushed (and CI green), **document the break in the changelog section
rather than force-pushing to add a footer** — rewriting published history to
improve release notes is a bad trade.

## `schemas/` is gitignored AND required — regenerate before packing

`schemas/` is in `.gitignore`, is listed in `package.json#files`, and is imported
by ~173 files under `modules/`. A fresh clone therefore has **no** `schemas/`, and
packing there yields a package that fails on every import:

```bash
bun run generate:schemas   # required whenever schemas/ is absent
```

## Verify the artifact, then verify the REGISTRY copy

`npm publish --dry-run` prints a `shasum` and `fileCount`. Record them *before*
publishing and compare afterwards — that is what proves the uploaded tarball is
the one you checked:

```bash
npm publish --dry-run                     # shasum: ee7950fc…  fileCount: 349
npm publish --otp=<code>
npm view @scope/pkg@<v> dist --json       # must match, byte for byte
```

## Verify as a CONSUMER, from the registry, with both installers

A CI smoke job that installs the **packed local tarball** structurally cannot
catch publish-time problems, and neither can `tsc` (it never resolves runtime
imports). Install the *published* version into a scratch project, with **no
`overrides`**, under `npm` **and** `bun`, and actually import it:

```bash
npm view @scope/pkg dist-tags        # latest must be the new version
# per installer, in a scratch dir:
<cli> install @scope/pkg@<v> effect@<pin> …           # no overrides
node -p "require('./node_modules/@effect/platform-node-shared/package.json').version"  # == pin
bun -e "await import('@scope/pkg')"                   # the only check that resolves runtime imports
```

Then re-run the README's own quick-start in a scratch project and **typecheck
it**. That is how documentation drift is caught — a wrong resource path or a stale
pin fails immediately. Also confirm what actually shipped inside the tarball
(e.g. `find node_modules/@scope/pkg/schemas -name '*.ts' | wc -l`), since
`files` + `.gitignore` is exactly where this goes wrong quietly.

## Install the README's line VERBATIM — root vs transitive deps resolve differently

Two consecutive releases shipped with a consumer install that could not work, and
both times the *test* was the reason it wasn't caught. Learned 2026-09-21, at
0.8.0's and 0.8.1's expense.

**0.8.0 never installed under npm.** `peerDependencies.typescript: "^7"` — an
exact-ish pin — made npm install `typescript@7.0.2` at the root, which cannot be
satisfied alongside alchemy's *optional* `@sveltejs/kit` → `typescript@^6` chain:
`npm error code ERESOLVE`. It passed CI because `consumer.sh` passed
`typescript@$TS_PEER` **explicitly** — a root pin satisfies the peer and lets npm
skip the conflicting optional peer.

**0.8.1 fixed that and still didn't install.** The smoke job then installed
`<tarball> effect@… platform-bun@… platform-node@…` — **omitting `alchemy`**, which
the README's line *does* name. As a **root** dependency alchemy's optional chain
competes and npm fails; as a **transitive** dependency (reached through our
package) the chain is skipped and it resolves. Same command, different tree.

**The fix that held:** make the tooling peer **optional**
(`peerDependenciesMeta: { typescript: { optional: true } }`) so npm installs no
compiler version at all, and document "bring TypeScript 6 or 7" instead. Verified
by installing **`@fllstck/nebius-alchemy@<version>` by name, with the README's
install line copied character for character**, under npm *and* bun: one copy of
each `@effect/*` package, no `ERESOLVE`, runtime import, and the README
quick-start typechecked.

Rules this earned:

1. **Copy the install line out of the README into the test.** If the test spells
   the dependencies itself, it is testing a different product. Any dependency the
   docs name belongs in the command, even when our package already depends on it.
2. **A root pin masks peer conflicts.** Passing a version explicitly at the root
   is exactly what a real consumer does *not* do, and it silences `ERESOLVE`.
3. **Never state a version you have not installed.** A range's lower bound is a
   claim; `>=5 <8` was narrowed to `>=6 <8` only because 6.0.3 was the version
   actually compiled against.
4. **Verify by name from the registry**, not only the packed tarball — 0.8.0's
   publish-time breakage was invisible to a local-tarball install.

## "Publishing…" + exit 0 is NOT a publish — verify the registry, every time

Learned the hard way at 0.9.0 (2026-09-23). `npm publish` printed:

```
npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access
npm notice Your package is being processed and may take a few minutes to become available.
http fetch PUT 202 https://registry.npmjs.org/@fllstck%2fnebius-alchemy
verbose exit 0
info ok
```

…and **nothing was ever published**: half an hour later `GET /@fllstck%2fnebius-alchemy/0.9.0` was still
404, the tarball URL was 404 and `dist-tags` still said `latest: 0.8.3`. A **202** means *queued*, and
when the queued publish is dropped the CLI says nothing — it exits **0**. (Same class as npm/cli#8936
and npm/npm#20077; the OTP path additionally regressed in npm/cli#8208.)

So never read success off the notice, and never off `exit 0`. Ask the registry, in the same breath:

```bash
npm publish
sleep 20   # a real publish lands in seconds; 202's "few minutes" is the tell that it did not
curl -s -o /dev/null -w 'version:   %{http_code}\n' "https://registry.npmjs.org/@fllstck%2fnebius-alchemy/0.9.0"   # want 200
curl -s -o /dev/null -w 'tarball:   %{http_code}\n' "https://registry.npmjs.org/@fllstck/nebius-alchemy/-/nebius-alchemy-0.9.0.tgz"   # want 200
curl -s "https://registry.npmjs.org/-/package/@fllstck%2fnebius-alchemy/dist-tags"                              # want latest: 0.9.0
```

`npm view <pkg>@<version>` is the same ground truth (its packument read can lag the CDN; the
per-version and tarball URLs do not). A retry is always safe while the version is absent — and once it
is present, a retry fails loudly with `403 You cannot publish over the previously published versions`,
which is the *good* failure mode.

**Why it was queued-and-dropped:** publishing requires either 2FA (OTP) or a **granular access token
with "bypass 2FA"** enabled. This account publishes with `auth-type=web` (browser login) plus
`--otp`, and that path can 202 silently. The reliable path is the token: npmjs.com → Access Tokens →
Granular, *Read and write* on the scope, **bypass 2FA** ticked, written to `~/.npmrc` as
`//registry.npmjs.org/:_authToken=…`. Note that with `auth-type=web` set, npm prefers the **keychain**,
so a fresh file token can be shadowed by a stale keychain entry — `npm logout --auth-type=web` (or
delete the "npm" keychain item) before switching to the token.

## "Did it publish?" — the diagnostic ladder

A release can *look* done — tag pushed, command exit 0 — while nothing reached
the registry. Work outward, and don't trust any single signal:

| Check | What it tells you |
| --- | --- |
| `npm view <pkg> versions` / `dist-tags` | whether the version exists at all (the only ground truth) |
| `~/.npm/_logs/*.log` | npm writes these **only on failure** — so a clean/old directory means no npm publish ran, *or* it succeeded. Not proof either way. |
| `npm whoami` | the token is valid — it does **not** imply publish rights |
| `npm owner ls <pkg>` + `npm access list packages <scope>` | whether you may publish at all (`read-write`) |
| `npm profile get` → `two-factor auth` | `auth-and-writes` ⇒ the publish needs `--otp=<code>` |

> ⚠️ **`bun publish` writes no npm debug log**, so a failed `bun publish` leaves no
> trace in `~/.npm/_logs`. For a 2FA account, `npm publish --otp=<code>` is the
> predictable path.

OTPs are single-use and expire in ~30 s, so a non-interactive shell cannot finish
the prompt: the maintainer runs the publish, or supplies a code that is used
immediately. And don't reach for `npm version` when `package.json` already holds
the target version — it re-bumps and triggers the `version` script (re-running the
changelog generator).

## Related

- `../agent-patterns/effect-versioning.md` — the peer/pin rules that make a
  dependency bump release-worthy
- `.github/smoke/consumer.sh` — the in-CI consumer check (local tarball; pair it
  with the registry install above)
- `alchemy-auth-provider.md` — testing the first-run path with an isolated `HOME`
