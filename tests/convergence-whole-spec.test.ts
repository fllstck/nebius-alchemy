/**
 * C1 (part 2) — the resources that converge *by construction*.
 *
 * `tests/convergence.test.ts` tabulates the resources whose reconcile compares spec fields
 * one by one — the only place the silent-loss bug can live. The resources here compare the
 * **whole desired spec** (`specDeepEqual(live.spec, desired)`), so every prop converges
 * through that single comparison and there is nothing to enumerate. `ai/v1/{endpoint,job}`
 * are the same idea one level up: their `diff` compares all props except `labels`, so any
 * other change plans a replace (they have no update RPC at all).
 *
 * The risk this file closes is a **classification drift**, not a missing comparison: if one
 * of these resources is ever rewritten to compare fields individually, its props silently
 * stop being covered by the table in the other file — and nothing would say so. So the claim
 * "this resource compares its spec wholesale" is asserted against the module source. It is a
 * deliberately narrow check (one pattern per resource, failing loudly with the file to look
 * at), not the broad "is this prop named anywhere?" audit that was tried and deleted twice —
 * those mis-classified providers that build `desired` before comparing it.
 *
 * The register itself lives in `tests/helpers/convergence.ts`, and
 * `tests/convergence-coverage.test.ts` proves every resource is in exactly one bucket.
 */
import * as BunTest from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { BY_CONSTRUCTION } from './helpers/convergence.ts'

const { describe, expect, test } = BunTest

const REPO_ROOT = join(import.meta.dir, '..')

describe('resources that converge by construction', () => {
  for (const { resource, file, pattern } of BY_CONSTRUCTION) {
    test(`${resource} still converges every prop wholesale (${file})`, () => {
      const source = readFileSync(join(REPO_ROOT, 'modules/resources', file), 'utf8')
      expect(
        pattern.test(source),
        `${resource} used to converge *every* prop through one whole-spec comparison, so it is not\n` +
          `tabulated prop-by-prop in tests/convergence.test.ts. ${file} no longer matches that shape —\n` +
          `either restore it, or move the resource into the convergence table (add a \`change\` patch per\n` +
          `prop, or declare it) so its props stay covered.`,
      ).toBe(true)
    })
  }
})
