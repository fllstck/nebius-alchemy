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
 */
import * as BunTest from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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
 * Run the real linter over `source` with only this rule enabled, reading the JSON report.
 *
 * Returns the exit status and the parsed diagnostics; throws with the raw output when the report is
 * not JSON (that happens when the config or the plugin could not be loaded, which is precisely the
 * failure a reader needs to see).
 */
const runOxlint = (source: string): { status: number; diagnostics: ReadonlyArray<Diagnostic> } => {
  const fixture = join(tempDir, 'fixture.ts')
  const config = join(tempDir, 'oxlintrc.json')
  writeFileSync(fixture, source)
  // `plugins: []` keeps every built-in rule out of the way: this test is about
  // our rule, and an unrelated diagnostic would change the exit status.
  writeFileSync(
    config,
    JSON.stringify({ plugins: [], jsPlugins: [PLUGIN], rules: { 'nebius/no-alchemy-deepequal': 'error' } }),
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

    const { status, diagnostics } = runOxlint(source)

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

    const { status, diagnostics } = runOxlint(source)

    expect(diagnostics).toEqual([])
    expect(status).toBe(0)
  })
})
