/**
 * `tools/schema-conformance.ts` — the branded-ID audit's classifier (R-15).
 *
 * The audit was advisory for its whole life: only the casing check could exit 1, so the ID half
 * printed a list that a human had to re-reason about every time (and AGENTS.md's count of the
 * leftovers had drifted from 13 to 16). It now exits 1 on any bare-string ID field whose own doc
 * comment does not carry `NOT branded: <reason>`.
 *
 * What is pinned here is the part that can silently degrade into "approves everything": **which
 * comment counts**. A marker anywhere else in the file — on the neighbouring field, or in the file
 * header — must not excuse a field, and the marker is the literal string rather than a loose pattern
 * over "unbranded"-ish wording. Both would look identical from the outside (an approved list that
 * never fails), which is exactly how `nebius/no-effect-ignore` spent its life configured `error` and
 * inert (R-05), and why the rules under `tools/` carry self-tests at all (R-04).
 */
import { describe, expect, test } from 'bun:test'

import {
  BRAND_EXCEPTION_MARKER,
  leadingBrandMarkerReason,
  partitionIdCandidates,
  type IdCandidate,
} from '../../tools/schema-conformance.ts'

/** Line-window helper: the marker for a field is read from the lines *above* it. */
const reasonAt = (source: string, field: string): string | undefined => {
  const lines = source.split('\n')
  const index = lines.findIndex((line) => line.trimStart().startsWith(field))
  if (index === -1) throw new Error(`fixture has no ${field} line`)
  return leadingBrandMarkerReason(lines, index)
}

describe('leadingBrandMarkerReason', () => {
  test('reads the reason from the doc comment directly above the field', () => {
    const source = [
      'const Schema = Schema.Struct({',
      '  /**',
      '   * The AWS-compatible access key ID (SID *value*).',
      '   * NOT branded: a credential value, not a Nebius resource ID.',
      '   */',
      '  accessKeyId: Schema.String,',
      '})',
    ].join('\n')

    // The *marker's* line is what is returned, decoration stripped, emphasis intact.
    expect(reasonAt(source, 'accessKeyId')).toBe(
      'NOT branded: a credential value, not a Nebius resource ID.',
    )
  })

  test('accepts a one-line doc comment', () => {
    const source = [
      'const Schema = Schema.Struct({',
      '  /** Optional rule identifier. NOT branded: opaque per-rule label, not a resource. */',
      '  id: Schema.optional(Schema.String),',
      '})',
    ].join('\n')

    expect(reasonAt(source, 'id')).toBe(
      'Optional rule identifier. NOT branded: opaque per-rule label, not a resource.',
    )
  })

  test('does NOT accept a marker on the neighbouring field — the walk is contiguous', () => {
    const source = [
      'const Schema = Schema.Struct({',
      '  /** NOT branded: this one is fine. */',
      '  previous: Schema.String,',
      '  sneakyId: Schema.String,',
      '})',
    ].join('\n')

    // This is the assertion that keeps the audit from being a rubber stamp: a file-wide search for
    // the marker would approve `sneakyId` here, and nothing else in the output would look different.
    expect(reasonAt(source, 'sneakyId')).toBeUndefined()
  })

  test('does NOT accept a marker separated by a blank line', () => {
    const source = [
      'const Schema = Schema.Struct({',
      '  /** NOT branded: for a field that is not this one. */',
      '',
      '  sneakyId: Schema.String,',
      '})',
    ].join('\n')

    expect(reasonAt(source, 'sneakyId')).toBeUndefined()
  })

  test('does NOT accept a marker from elsewhere in the file', () => {
    const source = [
      '// NOT branded: file-level note about something else entirely.',
      'const other = 1',
      'const Schema = Schema.Struct({',
      '  sneakyId: Schema.String,',
      '})',
    ].join('\n')

    expect(reasonAt(source, 'sneakyId')).toBeUndefined()
  })

  test('is the literal marker, not a family of "unbranded"-ish wordings', () => {
    // These are all wordings the repo used *before* R-15, and every one of them is rejected: a
    // pattern loose enough to accept them is the shape of rule that stops matching and nobody
    // notices.
    const nearMisses = [
      'The SID value — NOT a Nebius resource ID.',
      'An external IdP subject, deliberately unbranded.',
      'Unbranded: `\'\'` = auto-allocate.',
    ]

    for (const comment of nearMisses) {
      const source = ['const Schema = Schema.Struct({', `  /** ${comment} */`, '  sneakyId: Schema.String,', '})'].join('\n')
      expect(reasonAt(source, 'sneakyId')).toBeUndefined()
    }

    const exact = ['const Schema = Schema.Struct({', `  /** ${BRAND_EXCEPTION_MARKER}: why. */`, '  sneakyId: Schema.String,', '})'].join('\n')
    expect(reasonAt(exact, 'sneakyId')).toBe(`${BRAND_EXCEPTION_MARKER}: why.`)
  })

  test('a marker inside a `//` line counts too, since that is a comment', () => {
    const source = ['const Schema = Schema.Struct({', '  // NOT branded: a rule label.', '  id: Schema.String,', '})'].join('\n')

    expect(reasonAt(source, 'id')).toBe('NOT branded: a rule label.')
  })
})

const candidate = (field: string, reason?: string): IdCandidate => ({
  where: 'svc/v1/resource',
  line: 1,
  field,
  declaration: 'Schema.String',
  ...(reason === undefined ? {} : { reason }),
})

describe('partitionIdCandidates', () => {
  test('separates declared exceptions from unapproved candidates', () => {
    const { approved, unapproved } = partitionIdCandidates([
      candidate('externalId', 'NOT branded: an external identifier.'),
      candidate('sneakyId'),
      candidate('skuId', 'NOT branded: a catalog SKU.'),
    ])

    expect(approved.map((c) => c.field)).toEqual(['externalId', 'skuId'])
    expect(unapproved.map((c) => c.field)).toEqual(['sneakyId'])
  })

  test('treats an empty reason as undeclared rather than declaring it', () => {
    // `reason: ''` would otherwise read as "has a reason" in a truthiness check; the filter is on
    // `undefined` on purpose.
    const { unapproved } = partitionIdCandidates([candidate('id', undefined)])

    expect(unapproved.map((c) => c.field)).toEqual(['id'])
  })
})
