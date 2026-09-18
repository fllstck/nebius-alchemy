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
