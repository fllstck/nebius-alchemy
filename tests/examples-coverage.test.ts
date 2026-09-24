import * as BunTest from 'bun:test'
import { Glob } from 'bun'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { describe, expect, test } = BunTest

/**
 * Every resource is either **demonstrated in an example** or **accounted for in `examples/README.md`**.
 *
 * The coverage table drifted twice before this guard existed: a row was added *below* the table (so it read
 * as a stray line, and no table), `spot-pricing.ts` shipped without a section for a week's worth of commits,
 * and `ai-chat-instance.ts` — a whole example — had no section at all. Prose that is checked by eye rots;
 * the same discovery-plus-register pattern the convergence sweep uses makes "accounted for" mechanical:
 *
 *   * a resource mentioned on a **live** line of any `examples/*.ts` counts as demonstrated;
 *   * anything else must appear **by name** in `examples/README.md` (its §Coverage lists them with reasons);
 *   * and the counts stated in that section's opening line must match the audit, so the prose cannot drift
 *     away from the files it describes.
 *
 * Comments are tracked with a small state machine (`//`, `/* … *\/`) rather than a "does the line start with
 * `//`" heuristic, because a commented-out snippet inside a block comment would otherwise read as live.
 */
const REPO_ROOT = join(import.meta.dir, '..')

/** Same shapes `tests/convergence-coverage.test.ts` uses to find resource type strings. */
const TYPE_ALIAS_FORM = /Alchemy\.Resource<\s*'([\w.]+)'/
const CALL_FORM = /Alchemy\.Resource<[^(]*>\s*\(\s*'([\w.]+)'/
const NON_RESOURCE =
  /(\.schema\.ts$|\/index\.ts$|\/ids\.ts$|\/bindings\.ts$|\/hosted\.ts$|\/actions\.ts$|\/shared\/|(factory|utilities|validation)\.ts$)/

/** The public dotted path a consumer writes: `Nebius.billing.v1.PricingPolicy` → `Nebius.billing.PricingPolicy`. */
const publicName = (type: string) => type.replace(/\.v\d+\./, '.')

const discoveredResources = async (): Promise<ReadonlyArray<string>> => {
  const files = (await Array.fromAsync(new Glob('modules/resources/**/*.ts').scan(REPO_ROOT))).filter(
    (file) => !NON_RESOURCE.test(file),
  )
  const names = new Set<string>()
  for (const file of files) {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8')
    for (const match of [...source.matchAll(new RegExp(TYPE_ALIAS_FORM, 'g')), ...source.matchAll(new RegExp(CALL_FORM, 'g'))]) {
      const type = match[1]
      if (type !== undefined) names.add(publicName(type))
    }
  }
  return [...names].sort()
}

/** `Nebius.<service>.<Name>` mentions, split by whether the occurrence sits in a comment. */
const mentions = (source: string): { live: Set<string>; commented: Set<string> } => {
  const live = new Set<string>()
  const commented = new Set<string>()
  let inBlock = false
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    const isComment = inBlock || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')
    for (const match of line.matchAll(/Nebius\.(\w+)\.(\w+)/g)) {
      const name = `Nebius.${match[1]}.${match[2]}`
      ;(isComment ? commented : live).add(name)
    }
    // Track block-comment state after the mentions on this line have been classified.
    const opens = trimmed.includes('/*')
    const closes = trimmed.includes('*/')
    if (opens && !closes) inBlock = true
    else if (closes) inBlock = false
  }
  return { live, commented }
}

/** Every `Nebius.<service>.<Name>` mention across the example files, split live vs commented. */
const audit = (files: ReadonlyArray<string>, known: ReadonlySet<string>) => {
  const live = new Set<string>()
  const commented = new Set<string>()
  for (const file of files) {
    const found = mentions(readFileSync(join(REPO_ROOT, file), 'utf8'))
    for (const name of found.live) if (known.has(name)) live.add(name)
    for (const name of found.commented) if (known.has(name)) commented.add(name)
  }
  return { live, commented }
}

describe('examples coverage', () => {
  test('every resource is demonstrated, or accounted for in examples/README.md', async () => {
    const resources = await discoveredResources()
    expect(resources.length, 'no resources discovered — did the provider layout move?').toBeGreaterThan(0)

    const exampleFiles = (await Array.fromAsync(new Glob('examples/*.ts').scan(REPO_ROOT))).filter(
      (file) => !file.endsWith('-program.ts') && !file.endsWith('-worker.ts'),
    )
    const known = new Set(resources)
    const { live, commented } = audit(exampleFiles, known)
    // Derive `commentedOnly` **after** every file has been read: a resource that is commented out in one
    // example and used live in another is demonstrated, not commented-only (doing this per file counted it
    // twice, which is how this guard's own first version disagreed with the number it was checking).
    const commentedOnly = new Set([...commented].filter((name) => !live.has(name)))
    void commentedOnly

    const readme = readFileSync(join(REPO_ROOT, 'examples/README.md'), 'utf8')
    const coverage = readme.slice(readme.indexOf('## Coverage'))
    const unaccounted = resources.filter(
      (resource) => !live.has(resource) && !coverage.includes(resource),
    )
    expect(
      unaccounted,
      'these resources are neither used on a live line of an example nor listed in examples/README.md ' +
        '§Coverage. Either demonstrate them (or add a commented snippet) or give them a row with a reason — ' +
        'the section exists so "not demonstrated" is a decision rather than an oversight.',
    ).toEqual([])
  })

  test('the counts stated in the coverage section match the audit', async () => {
    const resources = await discoveredResources()
    const exampleFiles = (await Array.fromAsync(new Glob('examples/*.ts').scan(REPO_ROOT))).filter(
      (file) => !file.endsWith('-program.ts') && !file.endsWith('-worker.ts'),
    )
    const known = new Set(resources)
    const { live: demonstrated, commented: allCommented } = audit(exampleFiles, known)
    const commented = new Set([...allCommented].filter((name) => !demonstrated.has(name)))
    const absent = resources.length - demonstrated.size - commented.size
    const readme = readFileSync(join(REPO_ROOT, 'examples/README.md'), 'utf8')
    const stated = /(\d+) resources; (\d+) demonstrated, (\d+) commented-only, (\d+) absent/.exec(readme)
    expect(stated, 'examples/README.md §Coverage no longer opens with the audited counts').not.toBeNull()
    expect(
      [Number(stated![1]), Number(stated![2]), Number(stated![3]), Number(stated![4])],
      'the counts in examples/README.md §Coverage disagree with the files — update the line (or the files)',
    ).toEqual([resources.length, demonstrated.size, commented.size, absent])
  })
})
