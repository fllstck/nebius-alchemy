/**
 * C1 (part 3) — the register: every resource is covered by exactly one convergence bucket.
 *
 * The two behavioural files (`convergence.test.ts`, `convergence-whole-spec.test.ts`) can only
 * speak about the resources someone remembered to add. This file makes "remembered" mechanical:
 * it discovers every resource provider from `modules/`, reads its resource-type string, and
 * requires it to appear in **exactly one** of
 *
 * the per-prop convergence table in `tests/convergence.test.ts`. That is the only bucket:
 * the "by construction" register (whole-spec comparison, asserted against the module source)
 * and the hand-written prop-set guards of the no-update-RPC resources were both retired once
 * those resources were tabulated — a table row proves behaviour, a pattern proves only shape.
 *
 * Adding a resource therefore fails here until someone decides how its props converge — the
 * same forcing function as `plan-time-validation.test.ts`'s `EXPECTED_PROVIDER_COUNT`, but
 * derived rather than counted, so it cannot drift by an off-by-one. It is also the answer to
 * "is C1 complete?", which is otherwise a matter of trust.
 *
 * These are registry/discovery checks, not behaviour: the behaviour lives in the two files
 * above (and a bad `change` patch or a stale `declared` entry fails there).
 */
import { Glob } from 'bun'
import * as BunTest from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'


const { describe, expect, test } = BunTest

const REPO_ROOT = join(import.meta.dir, '..')

/**
 * The resource-type string. Two declaration shapes exist:
 *   - `export type X = Alchemy.Resource<'Nebius.a.b.C', …>` — the type string is the first
 *     type argument (the `Platform`-built Instance declares only this form),
 *   - `export const X = Alchemy.Resource<X>('Nebius.a.b.C')` — the type string is the call
 *     argument.
 */
const TYPE_ALIAS_FORM = /Alchemy\.Resource<\s*'([\w.]+)'/
const CALL_FORM = /Alchemy\.Resource<[^(]*>\s*\(\s*'([\w.]+)'/

/** Modules under `modules/resources` that are not resources. */
const NON_RESOURCE =
  /(\.schema\.ts$|\/index\.ts$|\/ids\.ts$|\/bindings\.ts$|\/hosted\.ts$|\/actions\.ts$|\/shared\/|modules\/resources\/(factory|utilities|validation)\.ts$)/

/** The table registrations: `resource: 'Nebius.dns.v1.Record'` inside a sweep config. */
const TABLED_RESOURCE = /^\s*resource: '([\w.]+)',/gm

interface Discovered {
  /** Directory-relative path of the provider module, e.g. `vpc/v1/network.ts`. */
  readonly file: string
  readonly resource: string
}

/** Every provider module that declares exactly one resource type. */
const discoverResources = async (): Promise<ReadonlyArray<Discovered>> => {
  const files = (await Array.fromAsync(new Glob('modules/resources/**/*.ts').scan(REPO_ROOT))).filter(
    (f) => !NON_RESOURCE.test(f),
  )

  const discovered: Array<Discovered> = []
  for (const file of files.sort()) {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8')
    const typeString = TYPE_ALIAS_FORM.exec(source) ?? CALL_FORM.exec(source)
    if (typeString?.[1] !== undefined) {
      discovered.push({ file: file.replace('modules/resources/', ''), resource: typeString[1] })
    }
  }
  return discovered
}

const tabledResources = (): ReadonlyArray<string> => {
  const source = readFileSync(join(import.meta.dir, 'convergence.test.ts'), 'utf8')
  return [...source.matchAll(TABLED_RESOURCE)].map((m) => m[1] as string)
}

describe('convergence register', () => {
  test('every resource is tabulated in the convergence sweep', async () => {
    const resources = await discoverResources()
    const tabled = tabledResources()

    const uncovered = resources.filter((r) => !tabled.includes(r.resource))
    expect(
      uncovered.map((r) => `${r.resource} (${r.file})`),
      'resources with no convergence table.\n' +
        '  Add a `change` patch per prop (or a `declared` reason) to tests/convergence.test.ts —\n' +
        '  the table is the only mechanism, so a resource outside it has no convergence proof.',
    ).toEqual([])

    // The register must not outlive the code either: a stale entry means the resource was
    // renamed or removed and the table is now inert.
    const known = new Set(resources.map((r) => r.resource))
    const stale = tabled.filter((r) => !known.has(r))
    expect(stale, 'registered resources that no longer exist — remove them').toEqual([])

    expect(resources.length).toBeGreaterThan(30)
  })
})
