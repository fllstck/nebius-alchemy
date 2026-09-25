/**
 * Behavioural tests for this repo's custom oxlint rules (`tools/oxlint-nebius-plugin`).
 *
 * The rules gate `bun run lint`, and oxlint's JS-plugin support is alpha, so the
 * behaviour is pinned here rather than assumed.
 *
 * These drive the **real** `oxlint` binary over a temp fixture with a temp config
 * rather than oxlint's `RuleTester`: `RuleTester` needs Node's raw-transfer
 * parser and refuses to run under Bun ("not supported on … other runtimes").
 * Spawning the binary is also the stronger test — it exercises plugin loading,
 * visitor wiring and rule-name resolution, i.e. the whole path `bun run lint`
 * takes. (oxlint already fails loudly if a rule name in `.oxlintrc.json` does not
 * exist in the plugin, so config wiring needs no test of its own.)
 *
 * ⚠️ **Assertions read `--format=json`, never the human report.** This file first
 * shipped parsing the pretty output (`toContain('fixture.ts:8:')`,
 * `output.match(/error nebius\(…\)/g)`), and it then failed on CI while passing on
 * macOS — on its very first CI run, since it is newer than v0.8.3. Reading
 * structure instead of prose removes every assumption that can differ by platform
 * (colour codes, layout, ordering, TTY detection), and an unparseable report now
 * fails with oxlint's *own* output attached — so a plugin-loading failure names
 * itself instead of showing up as a missing substring.
 *
 * `nebius/no-alchemy-deepequal` is the mechanical form of the AGENTS.md rule
 * "MUST compare protobuf specs/resources with `specDeepEqual` — never
 * `AlchemyDiff.deepEqual` directly": `deepEqual` canonicalizes every int64
 * (`Long`) to `undefined`, so two different disk sizes / TTLs / quota limits
 * compare equal and the drift check silently never fires. Both instances of that
 * bug found in a `reconcile` on 2026-09-21 (dns record `ttl`, dns zone
 * `soaSpec.negativeTtl`) were exactly this shape.
 *
 * **Every rule now carries a must-fail and a must-pass snippet** (`CASES` below, plus the two
 * hand-written `no-alchemy-deepequal` tests, and `rule coverage` fails if a new rule arrives
 * without them) — that is the whole point, because the two rules with the worst history here were
 * the ones nobody had ever watched *fail*: `no-effect-ignore` (severity `error`) could not see
 * `pipe(Effect.ignore)`, the only form the repo wrote, and `no-silent-error-swallow` banned
 * `() => Effect.void` — zero occurrences — while `() => Effect.succeed([])`, the shape that turns a
 * failed `list` into "this resource does not exist", sat uncaught in 31 places. A rule that has
 * never been observed failing is a comment with a schema, and "the lint is green" then reads as
 * evidence when it is not.
 */
import * as BunTest from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import plugin from '../../tools/oxlint-nebius-plugin/index.js'

const { afterAll, describe, expect, test } = BunTest

const REPO_ROOT = join(import.meta.dir, '../..')
const PLUGIN = join(REPO_ROOT, 'tools/oxlint-nebius-plugin/index.js')

/**
 * Locate the `oxlint` binary by walking up from this file.
 *
 * It lives in `node_modules/.bin`, which Stryker's mutation-testing sandbox does
 * not copy (Stryker always ignores `node_modules`), and a sandboxed `bun test`
 * resolves packages by walking up to the real install. Hard-coding
 * `<repo>/node_modules/.bin/oxlint` therefore breaks a dry run under Stryker; the
 * walk-up works from the repo root and from a sandbox beneath it alike.
 */
const findOxlint = (): string => {
  for (let dir = import.meta.dir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules/.bin/oxlint')
    if (existsSync(candidate)) return candidate
    if (dirname(dir) === dir) throw new Error(`oxlint binary not found above ${import.meta.dir}`)
  }
}

const OXLINT_BIN = findOxlint()

// Resolved from `import.meta.dir`, so this is also an assertion that the *plugin under test* exists
// where the test thinks it does — a missing file there would otherwise surface as oxlint's own
// "Failed to load JS plugin" and read like a rule bug.
if (!existsSync(PLUGIN)) {
  throw new Error(`the oxlint plugin under test is missing: ${PLUGIN} (cwd ${process.cwd()})`)
}

const tempDir = mkdtempSync(join(tmpdir(), 'nebius-oxlint-'))

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

/**
 * Run the real linter over `source` with only `rule` enabled, reading the JSON report.
 *
 * Returns the exit status and the parsed diagnostics; throws with the raw output when the report is
 * not JSON (that happens when the config or the plugin could not be loaded, which is precisely the
 * failure a reader needs to see).
 */
const runOxlint = (source: string, rule: string): { status: number; diagnostics: ReadonlyArray<Diagnostic> } => {
  const fixture = join(tempDir, 'fixture.ts')
  const config = join(tempDir, 'oxlintrc.json')
  writeFileSync(fixture, source)
  // `plugins: []` keeps every built-in rule out of the way: this test is about
  // our rule, and an unrelated diagnostic would change the exit status.
  writeFileSync(
    config,
    JSON.stringify({ plugins: [], jsPlugins: [PLUGIN], rules: { [`nebius/${rule}`]: 'error' } }),
  )

  const { status, output } = ((): { status: number; output: string } => {
    try {
      return {
        status: 0,
        output: execFileSync(OXLINT_BIN, ['--config', config, '--format=json', fixture], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      }
    } catch (error) {
      const failed = error as { status?: number; stdout?: string; stderr?: string; code?: string; message?: string }
      // `status` is undefined for a spawn failure (ENOENT/EACCES) — report that distinctly rather
      // than as "-1 diagnostics", because it means the environment, not the rule.
      if (failed.status === undefined) {
        throw new Error(`could not run oxlint (${failed.code ?? 'unknown'}): ${failed.message ?? ''}`)
      }
      return { status: failed.status, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` }
    }
  })()

  try {
    const parsed = JSON.parse(output) as { diagnostics?: ReadonlyArray<Diagnostic> }
    return { status, diagnostics: parsed.diagnostics ?? [] }
  } catch {
    throw new Error(`oxlint did not emit a JSON report (exit ${status}):\n${output}`)
  }
}

/** One oxlint diagnostic as `--format=json` renders it (only the fields asserted here). */
interface Diagnostic {
  readonly message: string
  readonly code: string
  readonly severity: string
  readonly filename: string
  readonly labels: ReadonlyArray<{ readonly span: { readonly line: number } }>
}

describe('nebius/no-alchemy-deepequal', () => {
  test('flags every way of reaching alchemy/Diff deepEqual, and only those', () => {
    // Line numbers are asserted below, so keep this fixture's shape stable.
    const source = [
      `import * as AlchemyDiff from 'alchemy/Diff'`, // 1
      `import * as Diff from 'alchemy/Diff'`, // 2
      `import { deepEqual } from 'alchemy/Diff'`, // 3
      `import { deepEqual as same } from 'alchemy/Diff'`, // 4
      `import { deepEqual as helper } from './other.ts'`, // 5
      `import * as ResourceUtils from './utilities.ts'`, // 6
      ``, // 7
      `export const a = AlchemyDiff.deepEqual(x, y)`, // 8  ← flag
      `export const b = Diff.deepEqual(x, y)`, // 9  ← flag
      `export const c = deepEqual(x, y)`, // 10 ← flag
      `export const d = same(x, y)`, // 11 ← flag
      `export const e = helper(x, y)`, // 12 ok: a different `deepEqual`
      `export const f = ResourceUtils.specDeepEqual(x, y)`, // 13 ok: the workaround
      `export const g = AlchemyDiff.isResolved(x)`, // 14 ok: unreachable by comparison
    ].join('\n')

    const { status, diagnostics } = runOxlint(source, 'no-alchemy-deepequal')

    expect(status).not.toBe(0)
    // Exactly the four reachable paths — no more, no fewer.
    expect(diagnostics).toHaveLength(4)
    expect(diagnostics.map((d) => d.code)).toEqual([
      'nebius(no-alchemy-deepequal)',
      'nebius(no-alchemy-deepequal)',
      'nebius(no-alchemy-deepequal)',
      'nebius(no-alchemy-deepequal)',
    ])
    expect(diagnostics.map((d) => d.severity)).toEqual(['error', 'error', 'error', 'error'])
    expect(diagnostics.map((d) => d.labels[0]!.span.line)).toEqual([8, 9, 10, 11])
    for (const diagnostic of diagnostics) {
      expect(diagnostic.filename.endsWith('fixture.ts')).toBe(true)
      // The message must name the fix, not just the mistake.
      expect(diagnostic.message).toContain('ResourceUtils.specDeepEqual')
    }
  })

  test('is silent on the sanctioned helper and on unrelated alchemy/Diff members', () => {
    const source = [
      `import * as AlchemyDiff from 'alchemy/Diff'`,
      `import * as ResourceUtils from './utilities.ts'`,
      `export const a = ResourceUtils.specDeepEqual(live.spec, desired)`,
      `export const b = AlchemyDiff.isResolved(news)`,
      `export const c = AlchemyDiff.diffTags(a, b)`,
    ].join('\n')

    const { status, diagnostics } = runOxlint(source, 'no-alchemy-deepequal')

    expect(diagnostics).toEqual([])
    expect(status).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// One must-fail and one must-pass snippet per rule (R-04)
// ---------------------------------------------------------------------------

/** A snippet plus what it is for. `source` is linted verbatim — it never needs to typecheck. */
interface RuleCase {
  readonly title: string
  readonly source: string
}

interface RuleCoverage {
  /** Each of these MUST produce a diagnostic for the rule under test. */
  readonly mustTrip: ReadonlyArray<RuleCase>
  /** Each of these must produce NO diagnostic at all — see the assertion below. */
  readonly mustPass: ReadonlyArray<RuleCase>
}

const CASES: Readonly<Record<string, RuleCoverage>> = {
  'no-effect-ignore': {
    mustTrip: [
      {
        // The form the repo actually wrote, and the reason the rule was inert while configured
        // `error`: `pipe(Effect.ignore)` passes the member by *reference*, so there is no
        // `CallExpression` to match. Before R-05 the rule only looked at the call form.
        title: 'piped by reference',
        source: `import * as Effect from 'effect/Effect'\nexport const swallow = Effect.succeed(1).pipe(Effect.ignore)`,
      },
      {
        title: 'called directly',
        source: `import * as Effect from 'effect/Effect'\nexport const swallow = Effect.ignore(Effect.succeed(1))`,
      },
    ],
    mustPass: [
      {
        // Effect v4's `ignore` takes an options object, and `log` makes the discarded `Cause`
        // (defects included) audible. That is the difference between "best effort, and you can see
        // it" and "best effort, and nobody will ever know", so the rule bans the silent forms only
        // — otherwise the one legitimate use needs an `oxlint-disable` with a comment.
        title: 'logged ignore options',
        source: `import * as Effect from 'effect/Effect'\nexport const audible = Effect.succeed(1).pipe(Effect.ignore({ log: 'Warn', message: 'best effort' }))`,
      },
      {
        title: 'catch and log',
        source: `import * as Effect from 'effect/Effect'\nexport const logged = Effect.succeed(1).pipe(Effect.catch((error) => Effect.logWarning(String(error))))`,
      },
    ],
  },

  'no-effect-catchallcause': {
    mustTrip: [
      {
        // Measured 2026-09-25: `catchAllCause` does not exist anywhere in the pinned Effect
        // (4.0.0-rc.117 — `grep -rl catchAllCause node_modules/effect/dist` finds nothing), so this
        // snippet proves the rule *fires*, not that it protects anything today. It is kept as a
        // guard against the v3 name coming back; the v4 spelling is `catchCause` (below).
        title: 'the v3 name',
        source: `import * as Effect from 'effect/Effect'\nexport const swallow = Effect.catchAllCause(Effect.succeed(1), () => Effect.succeed(0))`,
      },
    ],
    mustPass: [
      {
        // Deliberately NOT banned: catching a whole `Cause` is the right tool for best-effort work
        // (a destroy-path cleanup must not fail on a defect), and `no-silent-error-swallow` plus the
        // log-asserting tests are what keep it honest. The rule bans a name, not the capability.
        title: 'catchCause — the v4 capability',
        source: `import * as Effect from 'effect/Effect'\nexport const recovered = Effect.catchCause(Effect.succeed(1), (cause) => Effect.logWarning(String(cause)))`,
      },
    ],
  },

  'no-silent-error-swallow': {
    mustTrip: [
      {
        title: 'Effect.void handler',
        source: `import * as Effect from 'effect/Effect'\nexport const swallow = Effect.catchTag('GrpcError', () => Effect.void)`,
      },
      {
        // The shape the repo actually wrote, 32 times, while the rule could only see
        // `Effect.void` (0 occurrences): a failed `list` reported as "this resource does not exist".
        title: 'empty-array handler',
        source: `import * as Effect from 'effect/Effect'\nexport const swallow = Effect.catch(() => Effect.succeed([]))`,
      },
      {
        // `undefined` on a *get* is the swallow too: "not found" and "could not look" collapse.
        title: 'undefined handler',
        source: `import * as Effect from 'effect/Effect'\nexport const swallow = Effect.catch(() => Effect.succeed(undefined))`,
      },
      {
        title: 'null handler',
        source: `import * as Effect from 'effect/Effect'\nexport const swallow = Effect.catch(() => Effect.succeed(null))`,
      },
      {
        // The assertion is what the repo writes (`[] as readonly Attributes[]`); the value is the
        // same empty array, so unwrapping type-only wrappers is load-bearing.
        title: 'asserted empty array',
        source: `import * as Effect from 'effect/Effect'\nexport const swallow = Effect.catch(() => Effect.succeed([] as readonly string[]))`,
      },
      {
        title: 'block-bodied handler',
        source: `import * as Effect from 'effect/Effect'\nexport const swallow = Effect.catch(program, () => {\n  return Effect.succeed([])\n})`,
      },
    ],
    mustPass: [
      {
        title: 'handler that logs',
        source: `import * as Effect from 'effect/Effect'\nexport const logged = Effect.catchTag('GrpcError', (error) => Effect.logWarning(String(error)))`,
      },
      {
        // The sanctioned narrowing: only NOT_FOUND is benign, everything else is re-raised. This is
        // the shape every `modules/**` site had to reach (R-06), so it must never be flagged.
        title: 'narrowed to NOT_FOUND',
        source: `import * as Effect from 'effect/Effect'\nexport const narrowed = Effect.catchTag('GrpcError', (e) => (e.code === 5 ? Effect.succeed([]) : Effect.fail(e)))`,
      },
      {
        // Log, then answer empty: audible, so it is a deliberate decision rather than a swallow.
        title: 'log then empty',
        source: `import * as Effect from 'effect/Effect'\nexport const loud = Effect.catch((error) =>\n  Effect.logWarning(String(error)).pipe(Effect.andThen(Effect.succeed([]))),\n)`,
      },
      {
        // A non-empty constant is information, not a swallow (`succeed(0)`, `succeed('')`).
        title: 'non-empty constant',
        source: `import * as Effect from 'effect/Effect'\nexport const counted = Effect.catch(() => Effect.succeed(0))`,
      },
    ],
  },

  'no-disable-validation': {
    mustTrip: [
      {
        title: 'literal true',
        source: `export const options = { disableValidation: true }`,
      },
    ],
    mustPass: [
      {
        title: 'explicit false',
        source: `export const options = { disableValidation: false }`,
      },
      {
        title: 'non-literal value',
        source: `const disableValidation = false\nexport const options = { disableValidation }`,
      },
    ],
  },
}

/**
 * Rules whose cases are written out as dedicated tests (above) instead of a `CASES` entry, because
 * they assert diagnostic *line numbers* and an exact count — neither of which a table row can
 * express. Keeping the list short is the point; `rule coverage` fails on any rule in neither place.
 */
const DEDICATED_RULE_TESTS = ['no-alchemy-deepequal']

/** The plugin's own rule list — the completeness check's source of truth. */
const DECLARED_RULES = Object.keys(plugin.rules ?? {})

for (const [rule, coverage] of Object.entries(CASES)) {
  describe(rule, () => {
    for (const testCase of coverage.mustTrip) {
      test(`${testCase.title} — trips the rule`, () => {
        const { status, diagnostics } = runOxlint(testCase.source, rule)
        expect(status).not.toBe(0)
        expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(`nebius(${rule})`)
      })
    }

    for (const testCase of coverage.mustPass) {
      test(`${testCase.title} — passes`, () => {
        const { status, diagnostics } = runOxlint(testCase.source, rule)
        // Any diagnostic at all fails a must-pass case: a *different* rule firing here would be a
        // finding (the rules are supposed to be independent), not noise to filter out.
        expect(diagnostics).toEqual([])
        expect(status).toBe(0)
      })
    }
  })
}

describe('rule coverage', () => {
  test('every declared rule has a must-fail and a must-pass snippet', () => {
    const covered = new Set([...Object.keys(CASES), ...DEDICATED_RULE_TESTS])
    expect(DECLARED_RULES.filter((rule) => !covered.has(rule))).toEqual([])
    // …and no case names a rule the plugin does not declare, which is how a rename would silently
    // orphan a case that no longer tests anything.
    expect(Object.keys(CASES).filter((rule) => !DECLARED_RULES.includes(rule))).toEqual([])
  })

  test('the plugin declares exactly the five documented rules', () => {
    // A new rule changes this list, and that is the prompt to add its cases above: without this the
    // count could drift while the completeness check above still passed for the wrong reason.
    expect(DECLARED_RULES.toSorted()).toEqual([
      'no-alchemy-deepequal',
      'no-disable-validation',
      'no-effect-catchallcause',
      'no-effect-ignore',
      'no-silent-error-swallow',
    ])
  })
})
