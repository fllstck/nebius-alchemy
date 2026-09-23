/**
 * One-off: converge `labels` on every remaining provider that has an update call.
 *
 * Two mechanical edits per file, both of which the vpc family established:
 *
 *   1. the create branch's `internalLabels`/`labels` pair moves **above** the branch as
 *      `const labels = yield* Factory.mergedLabels(id, news.labels)`, so the same merged map is available to
 *      the update; and
 *   2. the update's `metadata` gains `labels,`.
 *
 * Files whose shapes differ are listed rather than guessed at, so they can be done by hand.
 *
 *   bun spikes/converge-labels-sweep.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const note = `    // The merged labels are computed **once** and sent on the update as well as the create: an update
    // that omits \`metadata.labels\` leaves the live map untouched, so converging a labels-only change
    // means carrying the full intended set every time (and a label removed from config is then removed in
    // the cloud — measured 2026-09-24, AGENTS.md §Convergence).
`
const localPairs = [
  `      const internalLabels = yield* AlchemyTags.createInternalTags(id)
      const labels = { ...internalLabels, ...news.labels }

`,
  `    const internalLabels = yield* AlchemyTags.createInternalTags(id)
    const labels = { ...internalLabels, ...news.labels }

`,
]

const single = /metadata: \{ id: (\w+)\.metadata!\.id, resourceVersion: \1\.metadata!\.resourceVersion\.toString\(\) \},/
const multi =
  /metadata: \{\n(\s+)id: (\w+)\.metadata!\.id,\n\s+resourceVersion: \2\.metadata!\.resourceVersion\.toString\(\),\n(\s+)\},/

const files = execSync("grep -rl '\\.update({' modules/resources --include=*.ts", { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter((file) => !file.includes('vpc/v1/'))

const done = []
const skipped = []

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  if (source.includes('Factory.mergedLabels')) {
    skipped.push(`${file} — already converged`)
    continue
  }
  const pair = localPairs.find((candidate) => source.includes(candidate))
  if (pair === undefined) {
    skipped.push(`${file} — create-branch label pair not in the expected shape`)
    continue
  }
  let next = source.replace(pair, '')
  const createBranch = /( *)(if \(!\w+\) \{\n)/m
  if (!createBranch.test(next)) {
    skipped.push(`${file} — create branch not found`)
    continue
  }
  next = next.replace(createBranch, `${note}    const labels = yield* Factory.mergedLabels(id, news.labels)\n$1$2`)

  if (single.test(next)) {
    next = next.replace(
      single,
      (_match, variable) =>
        `metadata: {\n          id: ${variable}.metadata!.id,\n          resourceVersion: ${variable}.metadata!.resourceVersion.toString(),\n          labels,\n        },`,
    )
  } else if (multi.test(next)) {
    next = next.replace(
      multi,
      (_match, indent, variable, closing) =>
        `metadata: {\n${indent}id: ${variable}.metadata!.id,\n${indent}resourceVersion: ${variable}.metadata!.resourceVersion.toString(),\n${indent}labels,\n${closing}},`,
    )
  } else {
    skipped.push(`${file} — update metadata shape not matched (labels hoisted, metadata NOT edited)`)
    writeFileSync(file, next)
    continue
  }

  writeFileSync(file, next)
  done.push(file)
}

console.log(`converged (${done.length}):`)
for (const file of done) console.log(`  ${file}`)
console.log(`\nneeds a hand (${skipped.length}):`)
for (const file of skipped) console.log(`  ${file}`)
