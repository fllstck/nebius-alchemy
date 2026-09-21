/**
 * C1 (part 3) — the register: every resource is covered by exactly one convergence bucket.
 *
 * The two behavioural files (`convergence.test.ts`, `convergence-whole-spec.test.ts`) can only
 * speak about the resources someone remembered to add. This file makes "remembered" mechanical:
 * it discovers every resource provider from `modules/`, reads its resource-type string, and
 * requires it to appear in **exactly one** of
 *
 *   1. a per-prop convergence table (parsed out of `tests/convergence.test.ts`),
 *   2. the by-construction register (whole-spec / props-except-labels comparisons),
 *   3. a hand-written prop-set guard (resources with no update RPC, AGENTS.md §Convergence).
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

import { BY_CONSTRUCTION, PROP_SET_GUARDS } from './helpers/convergence.ts'

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

/** `Object.keys(<PropsSchema>.fields)` in the guard's test file. */
const guardHolds = (propsSchema: string, testFile: string): boolean =>
  readFileSync(join(import.meta.dir, 'resources', testFile), 'utf8').includes(`${propsSchema}.fields`)

describe('convergence register', () => {
  test('every resource is in exactly one convergence bucket', async () => {
    const resources = await discoverResources()
    const tabled = new Set(tabledResources())
    const byConstruction = new Set(BY_CONSTRUCTION.map((r) => r.resource))
    const guarded = new Set(PROP_SET_GUARDS.map((r) => r.resource))

    const uncovered = resources.filter(
      (r) => !tabled.has(r.resource) && !byConstruction.has(r.resource) && !guarded.has(r.resource),
    )
    expect(
      uncovered.map((r) => `${r.resource} (${r.file})`),
      'resources with no convergence classification.\n' +
        '  Give the resource a `change` patch per prop in tests/convergence.test.ts (its reconcile\n' +
        '  compares fields one by one), or add it to BY_CONSTRUCTION in tests/helpers/convergence.ts\n' +
        '  (it compares the whole spec), or — if it has no update RPC — to PROP_SET_GUARDS.',
    ).toEqual([])

    const buckets: ReadonlyArray<[string, ReadonlySet<string>]> = [
      ['convergence table', tabled],
      ['by construction', byConstruction],
      ['prop-set guard', guarded],
    ]
    const duplicated = resources
      .map((r) => ({
        resource: r.resource,
        buckets: buckets.filter(([, set]) => set.has(r.resource)).map(([name]) => name),
      }))
      .filter((entry) => entry.buckets.length > 1)
      .map((entry) => `${entry.resource}: ${entry.buckets.join(' + ')}`)
    expect(duplicated, 'resources classified in more than one bucket — pick one').toEqual([])

    // The register must not outlive the code either: a stale entry means the resource was
    // renamed or removed and the table/guard is now inert.
    const known = new Set(resources.map((r) => r.resource))
    const stale = [...tabled, ...byConstruction, ...guarded].filter((r) => !known.has(r))
    expect(stale, 'registered resources that no longer exist — remove them').toEqual([])

    expect(resources.length).toBeGreaterThan(30)
  })

  test('every prop-set guard still pins its schema', () => {
    for (const { resource, propsSchema, testFile } of PROP_SET_GUARDS) {
      expect(guardHolds(propsSchema, testFile), `${resource}: ${testFile} no longer pins ${propsSchema}.fields`).toBe(
        true,
      )
    }
  })
})
