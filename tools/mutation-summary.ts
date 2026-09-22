/**
 * Turn Stryker's JSON report into a Markdown job summary.
 *
 * Why this exists: mutation testing is a **signal, not a gate** (AGENTS.md §Testing — the score
 * moves ±1–2 mutants between identical runs), so the nightly job stays green with survivors and a
 * human has to *read* the result. A `clear-text` report scrolls away in the log and the JSON artifact
 * needs downloading, so this prints the two things that make the score actionable, in the "Summary"
 * panel of the run:
 *
 *   * the per-file table (the same numbers `clear-text` prints), and
 *   * every surviving / uncovered mutant with its **source line**, because "`Disk.ts:214` survived the
 *     `BlockStatement` mutant" is actionable and "98 %" is not.
 *
 * Score formula mirrors Stryker's own (`detected / valid`, where a timeout counts as detected and
 * ignored mutants are excluded) — verified against `clear-text` output when this was written.
 *
 * Never fails: a missing or unreadable report is reported as such and exits 0. The job's failure
 * signal belongs to Stryker, not to its summariser.
 *
 * Usage (CI): `bun tools/mutation-summary.ts >> "$GITHUB_STEP_SUMMARY"` (or print to stdout locally).
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPORT = process.env.MUTATION_REPORT ?? 'reports/mutation/mutation.json'
const ROOT = process.cwd()

interface Mutant {
  readonly mutatorName: string
  readonly status: string
  readonly statusReason?: string
  readonly replacement?: string
  readonly location: { readonly start: { readonly line: number; readonly column: number } }
}

interface Report {
  readonly files: Record<string, { readonly mutants: ReadonlyArray<Mutant> }>
}

const DETECTED = new Set(['Killed', 'Timeout'])
const UNDETECTED = ['Survived', 'NoCoverage'] as const

const readReport = (): Report | undefined => {
  const path = resolve(ROOT, REPORT)
  if (!existsSync(path)) {
    console.log(`> ⚠️ No mutation report at \`${REPORT}\` — the run did not get far enough to write one.`)
    return undefined
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Report
  } catch (cause) {
    console.log(`> ⚠️ Could not parse \`${REPORT}\`: ${cause instanceof Error ? cause.message : String(cause)}`)
    return undefined
  }
}

/** The source line a mutant sits on, so the summary needs no second click. */
const sourceLine = (file: string, line: number): string => {
  try {
    return readFileSync(resolve(ROOT, file), 'utf8').split('\n')[line - 1]?.trim() ?? ''
  } catch {
    return ''
  }
}

const score = (mutants: ReadonlyArray<Mutant>): { detected: number; valid: number; percent: number } => {
  const detected = mutants.filter((m) => DETECTED.has(m.status)).length
  const undetected = mutants.filter((m) => (UNDETECTED as ReadonlyArray<string>).includes(m.status)).length
  const valid = detected + undetected
  return { detected, valid, percent: valid === 0 ? 100 : (detected / valid) * 100 }
}

const report = readReport()
if (report === undefined) process.exit(0)

const rows = Object.entries(report.files)
  .map(([file, info]) => {
    const { detected, valid, percent } = score(info.mutants)
    const count = (status: string) => info.mutants.filter((m) => m.status === status).length
    return { file, detected, valid, percent, survived: count('Survived'), noCoverage: count('NoCoverage') }
  })
  .toSorted((a, b) => a.percent - b.percent)

const totals = rows.reduce(
  (acc, r) => ({ detected: acc.detected + r.detected, valid: acc.valid + r.valid }),
  { detected: 0, valid: 0 },
)
const overall = totals.valid === 0 ? 100 : (totals.detected / totals.valid) * 100

console.log('## Mutation testing (nightly)\n')
console.log(
  '**Signal, not a gate**: the job is green with survivors by design (`thresholds.break: null`; the\n' +
    'score moves ±1–2 mutants between identical runs). What matters is the *trend* and the survivors below.\n',
)
console.log(`**Overall: ${overall.toFixed(2)} %** (${totals.detected}/${totals.valid} detected)\n`)
console.log('| file | score | detected | survived | no coverage |')
console.log('| --- | --- | --- | --- | --- |')
for (const row of rows) {
  console.log(`| \`${row.file}\` | ${row.percent.toFixed(2)} % | ${row.detected}/${row.valid} | ${row.survived} | ${row.noCoverage} |`)
}

const undetected = rows.filter((r) => r.survived + r.noCoverage > 0)
if (undetected.length > 0) {
  console.log('\n<details><summary>Surviving / uncovered mutants (with source lines)</summary>\n')
  for (const row of undetected) {
    console.log(`### \`${row.file}\`\n`)
    const info = report.files[row.file]!
    for (const status of UNDETECTED) {
      const mutants = info.mutants
        .filter((m) => m.status === status)
        .toSorted((a, b) => a.location.start.line - b.location.start.line)
      for (const mutant of mutants) {
        const { line } = mutant.location.start
        console.log(`- **${status}** \`${row.file}:${line}\` ${mutant.mutatorName}: \`${sourceLine(row.file, line)}\``)
      }
    }
    console.log('')
  }
  console.log('</details>\n')
}
console.log(
  '\n> Deliberately-unreachable mutants are documented in TASKS.md (§"Deliberately left uncovered") — ' +
    'they are not a backlog.',
)
