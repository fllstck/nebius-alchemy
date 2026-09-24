/**
 * The label-map rule table — and, just as importantly, the rule that is **absent**.
 *
 * `labels` is the same field name on every resource in this package, and the temptation is to give it one
 * shared schema. Measured live 2026-09-24 (`spikes/labels-empty-key-probe.ts`), the API's answer is
 * service-*dependent*, so there are two schemas and a lot of deliberate bare `Record`s:
 *
 * | map | `''` | `'  '` |
 * | `computeLabelMap` (compute metadata, incl. `mk8s` `instanceMetadata.labels`) | **rejected** | accepted |
 * | `kubernetesLabelMap` (`mk8s` `template.metadata.labels`) | **rejected** | **rejected** (Kubernetes has no blank label name) |
 * | `vpc/v1 Network.metadata.labels` and every other unmeasured service | **accepted and stored** — no filter |
 *
 * The third row is why this file also asserts *acceptance*: a package-wide filter would be a regression for
 * VPC (it would reject a configuration the platform stores and echoes back), and the fix for the audit item
 * that asked for one was to measure instead of unifying.
 */
import * as BunTest from 'bun:test'
import * as Schema from 'effect/Schema'

import { computeLabelMap, kubernetesLabelMap } from '../../../modules/resources/shared/label-map.ts'

const { describe, expect, test } = BunTest

/**
 * The shared schemas are `Schema.Record(...).check(...)`, whose **encoded** type is a typed record — so
 * the `decodeUnknown*` APIs, which require a `ConstraintDecoder` (encoded `unknown`), refuse them at the
 * type level while decoding them correctly at runtime. One cast, in one place, so this test can assert the
 * rule table directly rather than only through three resource validators.
 */
const decoder = <T>(schema: Schema.Schema<T>): Schema.ConstraintDecoder<T> =>
  schema as unknown as Schema.ConstraintDecoder<T>

/** The decoded map when the schema accepts it, `undefined` when it rejects. */
const accepted = (
  schema: Schema.Schema<Record<string, string>>,
  input: Record<string, string>,
): Record<string, string> | undefined => {
  try {
    return Schema.decodeUnknownSync(decoder(schema))(input)
  } catch {
    return undefined
  }
}

/** The rejection message when the schema refuses, `undefined` when it accepts. */
const rejection = (
  schema: Schema.Schema<Record<string, string>>,
  input: Record<string, string>,
): string | undefined => {
  try {
    Schema.decodeUnknownSync(decoder(schema))(input)
    return undefined
  } catch (error) {
    return String(error)
  }
}

describe('shared/label-map', () => {
  describe('computeLabelMap — compute rejects only a strictly EMPTY key', () => {
    test('accepts a normal map', () => {
      expect(accepted(computeLabelMap, { env: 'prod', team: 'core' })).toEqual({ env: 'prod', team: 'core' })
    })

    // The control that makes the rejection below mean something: the API accepted a disk with valid labels
    // *in the same probe run* as the one it refused for the empty key.
    test('accepts a blank key — measured: compute stores `"  "`', () => {
      expect(accepted(computeLabelMap, { '  ': 'spaces', ok: 'yes' })).toEqual({ '  ': 'spaces', ok: 'yes' })
    })

    test('rejects an empty key, naming the prop and quoting the API message', () => {
      const message = rejection(computeLabelMap, { '': 'x', ok: 'yes' })
      expect(message).toBeDefined()
      expect(message).toContain('empty key')
      // The API's own wording is generic and names neither the label nor the reason, which is the whole
      // point of catching it at plan time.
      expect(message).toContain('metadata.labels is invalid')
    })

    test('accepts an empty VALUE — only keys are constrained', () => {
      expect(accepted(computeLabelMap, { ok: '' })).toEqual({ ok: '' })
    })
  })

  describe('kubernetesLabelMap — Kubernetes has no empty *or* blank label name', () => {
    test('accepts a normal map', () => {
      expect(accepted(kubernetesLabelMap, { role: 'worker' })).toEqual({ role: 'worker' })
    })

    test('rejects an empty key', () => {
      expect(rejection(kubernetesLabelMap, { '': 'worker' })).toContain('empty or blank')
    })

    test('rejects a blank key — stricter than compute, on purpose', () => {
      expect(rejection(kubernetesLabelMap, { '  ': 'worker' })).toContain('empty or blank')
    })
  })
})
