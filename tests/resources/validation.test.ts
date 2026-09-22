/**
 * Boundary tests for the shared field filters in `modules/resources/validation.ts`.
 *
 * These filters are the last gate before an API call, and they were only *example*-
 * tested. A mutation-testing run over this file (`bun run mutation`, baseline
 * 2026-09-21: 39.4 % score, 74 behavioural survivors) showed every survivor was a
 * boundary nobody had pinned: `s.length <= 63` → `< 63`, the `$` anchor dropped from
 * the resource-name regex, `/12`-style prefix-only CIDRs, a 3-octet CIDR, `prefix >
 * 32` → `>= 32`, `isValidPort`'s upper bound, `isValidBlockSize`'s in-range
 * non-power-of-two, and the empty-labels case of every `length >= 1` guard.
 *
 * Two conventions here, both forced by that run:
 *
 * - **Pin boundaries on the accepting side too.** A filter that rejects everything
 *   passes any rejection-only test, and `n <= 63` → `n < 63` is invisible unless the
 *   63-character name is asserted *accepted*.
 * - **Where two rejection paths exist, pin the message.** `/24` (prefix-only) and
 *   `1.2.3/24` (three octets) are both rejected, so a mutant that swaps *which*
 *   branch fires is only killed by asserting the distinguishing text. That text is
 *   user-facing — it is what `alchemy plan` prints.
 */
import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import { generateKeyPairSync } from 'node:crypto'
import * as Schema from 'effect/Schema'

import * as Validation from '../../modules/resources/validation.ts'
import { RSA_4096_PUBLIC_KEY_A, RSA_4096_PUBLIC_KEY_B, SELF_SIGNED_CERT } from '../helpers/fixtures.ts'
import { runEffect } from '../helpers/provider.ts'

const { describe, expect, test } = BunTest

/**
 * Run a standalone filter through a one-field schema — the same shape the props
 * validators apply it in — and return the failure text (`undefined` = accepted).
 *
 * Via the shared `runEffect` helper: `decodeUnknownEffect`'s dual infers
 * `R = unknown` for a generic schema, which `Effect.runPromise` won't accept.
 */
const failureText = <A>(schema: Schema.Schema<A>, value: unknown): Promise<string | undefined> =>
  runEffect(
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.as(undefined as string | undefined),
      Effect.catch((error: { message: string }) => Effect.succeed(error.message)),
    ),
  )

interface Case {
  readonly value: string | number
  readonly accept: boolean
  /** Distinguishing text of the expected message; only needed where two paths could fire. */
  readonly because?: string
}

/** Register one test per case, so a failure names the exact value that broke. */
const cases = <A>(label: string, schema: Schema.Schema<A>, table: ReadonlyArray<Case>): void => {
  for (const c of table) {
    test(`${label}: ${JSON.stringify(c.value)} is ${c.accept ? 'accepted' : 'rejected'}`, async () => {
      const failure = await failureText(schema, c.value)
      expect(failure === undefined).toBe(c.accept)
      if (!c.accept && c.because !== undefined) expect(failure).toContain(c.because)
    })
  }
}

const DNS_NAME = 'Resource name must be 3-63'
const CIDR = 'Invalid CIDR notation'
const CIDR_PREFIX_ONLY = 'Prefix-only CIDR'
const CIDR_PREFIX_RANGE = 'CIDR prefix must be 0-32'
const CIDR_OCTETS = 'Invalid IP address in CIDR'
const CIDR_OCTET_RANGE = 'IP octet out of range 0-255'

describe('validation filters', () => {
  describe('isDnsCompliantResourceName', () => {
    cases('name', Schema.String.check(Validation.isDnsCompliantResourceName), [
      // Accepting side: the length cap and the char class both have to allow these.
      { value: 'abc', accept: true },
      { value: 'a1b', accept: true },
      { value: 'a-b', accept: true },
      { value: '0abc', accept: true },
      { value: 'a'.repeat(63), accept: true }, // kills `<= 63` → `< 63`
      // Rejecting side.
      { value: 'ab', accept: false, because: DNS_NAME }, // kills `>= 3 && <= 63` → `||`
      { value: '', accept: false, because: DNS_NAME },
      { value: 'a'.repeat(64), accept: false, because: DNS_NAME },
      { value: '-abc', accept: false },
      { value: 'abc-', accept: false }, // kills dropping the `$` anchor
      { value: 'abc!', accept: false }, // ditto — fails ONLY via the anchor
      { value: 'ABC', accept: false },
      { value: 'a_b', accept: false },
      { value: 'a b', accept: false },
    ])
  })

  describe('isValidCIDR', () => {
    cases('cidr', Schema.String.check(Validation.isValidCIDR), [
      // Accepting side — the boundary prefixes 0 and 32 must both pass.
      { value: '10.0.0.0/24', accept: true },
      { value: '0.0.0.0/0', accept: true }, // kills `prefix < 0` → `<= 0`
      { value: '255.255.255.255/32', accept: true }, // kills `prefix > 32` → `>= 32`
      { value: '10.0.0.0/32', accept: true },
      // Prefix-only form: rejected, and by *that* branch (message assertion kills every
      // mutant that would let it fall through to the generic branch instead).
      { value: '/24', accept: false, because: CIDR_PREFIX_ONLY },
      { value: '/1', accept: false, because: CIDR_PREFIX_ONLY }, // kills `\d{1,2}` → `\D{1,2}`
      { value: '/12', accept: false, because: CIDR_PREFIX_ONLY }, // kills `\d{1,2}` → `\d`
      // NOT prefix-only: without the `$` anchor the regex would match and the message
      // would become `Prefix-only CIDR …`, so pinning this one kills that mutant.
      { value: '/12abc', accept: false, because: CIDR_OCTETS },
      // Malformed shapes, each reaching a different branch.
      // `a/b/c` splits into 3 parts; skipping that check lands on `parseInt('b')` → NaN.
      { value: 'a/b/c', accept: false, because: CIDR }, // kills `parts.length !== 2` → false
      { value: '10.0.0.0/abc', accept: false, because: CIDR_PREFIX_RANGE }, // kills `isNaN(prefix)` → false
      { value: '10.0.0.0/33', accept: false, because: CIDR_PREFIX_RANGE },
      { value: '10.0.0.0/-1', accept: false, because: CIDR_PREFIX_RANGE }, // kills `prefix < 0` → false
      { value: '1.2.3/24', accept: false, because: CIDR_OCTETS }, // kills `octets.length !== 4` → false
      { value: '10.0.0.256/24', accept: false, because: CIDR_OCTET_RANGE }, // kills the loop body + `(a||b)&&c`
      { value: '10.0.0./24', accept: false, because: CIDR_OCTET_RANGE },
      { value: '10.0.0.-1/24', accept: false, because: CIDR_OCTET_RANGE }, // kills `n < 0` → false
      { value: '256.0.0.1/24', accept: false, because: CIDR_OCTET_RANGE },
    ])
  })

  describe('isValidPort', () => {
    cases('port', Schema.Finite.check(Validation.isValidPort), [
      { value: 1, accept: true }, // kills `n >= 1` → `> 1`
      { value: 443, accept: true },
      { value: 65535, accept: true }, // kills `n <= 65535` → `< 65535`
      { value: 0, accept: false, because: 'Port must be 1-65535' },
      { value: 65536, accept: false, because: 'Port must be 1-65535' },
      { value: -1, accept: false, because: 'Port must be 1-65535' },
      { value: 1.5, accept: false, because: 'Port must be 1-65535' }, // kills `Number.isInteger` → true
    ])
  })

  describe('isValidBootDiskSizeGibibytes', () => {
    cases('bootDiskSizeGiB', Schema.Finite.check(Validation.isValidBootDiskSizeGibibytes), [
      { value: 64, accept: true }, // kills `n >= 64` → `> 64`
      { value: 1024, accept: true },
      { value: 63, accept: false, because: 'Boot disk must be at least 64 GiB' },
      { value: 0, accept: false, because: 'Boot disk must be at least 64 GiB' },
      { value: -1, accept: false, because: 'Boot disk must be at least 64 GiB' },
    ])
  })

  describe('isValidMountTag', () => {
    cases('mountTag', Schema.String.check(Validation.isValidMountTag), [
      { value: 'x', accept: true }, // kills `length >= 1` → `>= 0`
      { value: 'x'.repeat(37), accept: true }, // kills `length <= 37` → `< 37`
      { value: '', accept: false, because: 'Mount tag must be 1-37' },
      { value: 'x'.repeat(38), accept: false, because: 'Mount tag must be 1-37' },
    ])
  })

  describe('isValidBlockSize', () => {
    cases('blockSize', Schema.Finite.check(Validation.isValidBlockSize), [
      { value: 4096, accept: true }, // kills `n < 4096` → `<= 4096`
      { value: 8192, accept: true },
      { value: 131072, accept: true }, // kills `n > 131072` → `>= 131072`
      { value: 4095, accept: false, because: 'Block size must be between 4096 and 131072' },
      { value: 131073, accept: false, because: 'Block size must be between 4096 and 131072' },
      // In range but not a power of two — the second branch, which the first masks for
      // any out-of-range value.
      { value: 5000, accept: false, because: 'Block size must be a power of two' },
      { value: 12288, accept: false, because: 'Block size must be a power of two' },
    ])
  })

  describe('isSupportedAuthPublicKey (the only shape the IAM API takes)', () => {
    const schema = Schema.String.check(Validation.isSupportedAuthPublicKey)
    // 4096-bit RSA keys come from the fixtures (real key material, no keygen); the *rejected*
    // neighbours are generated here, because generating them is what proves the boundary.
    const rsa = (modulusLength: number) =>
      generateKeyPairSync('rsa', { modulusLength }).publicKey.export({ type: 'spki', format: 'pem' }).toString()

    cases('authPublicKey', schema, [
      { value: RSA_4096_PUBLIC_KEY_A, accept: true },
      { value: RSA_4096_PUBLIC_KEY_B, accept: true },
      { value: rsa(2048), accept: false, because: 'accepts only 4096-bit RSA public keys; got 2048-bit' },
      { value: rsa(3072), accept: false, because: 'accepts only 4096-bit RSA public keys; got 3072-bit' },
      { value: rsa(4096), accept: true },
      {
        value: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        accept: false,
        because: 'accepts only RSA public keys; got ed25519',
      },
      {
        value: generateKeyPairSync('ec', { namedCurve: 'P-256' })
          .publicKey.export({ type: 'spki', format: 'pem' })
          .toString(),
        accept: false,
        because: 'accepts only RSA public keys; got ec',
      },
      // Shape-valid but not parsable: the API answers `Invalid public key data: expected public key
      // in PEM-format`, which names the wrong problem — say it here instead.
      {
        value: '-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----',
        accept: false,
        because: 'Not a parsable public key PEM',
      },
      // A CERTIFICATE is not a public key (and `isPemFormat` alone would accept it) — and Node
      // happily extracts the key from one, so the label check is what catches it.
      { value: SELF_SIGNED_CERT, accept: false, because: 'Expected a public key, not a certificate' },
    ])

    // Exact messages, not `toContain`: the whole point of this filter is what it *says* (the API's own
    // text is misleading), and a substring assertion lets a mutated message through.
    test('the size message quotes the API error text, so the constraint is traceable', async () => {
      const failure = await failureText(schema, rsa(2048))
      expect(failure).toBe(
        'The IAM API accepts only 4096-bit RSA public keys; got 2048-bit. ' +
          'Smaller sizes are rejected with "Key doesn\'t fits to any supported algorithms".',
      )
    })

    test('the non-RSA message explains why the API error is misleading', async () => {
      const failure = await failureText(
        schema,
        generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      )
      expect(failure).toBe(
        'The IAM API accepts only RSA public keys; got ed25519. ' +
          'Ed25519 and ECDSA keys are valid PEM but rejected by the service with "Invalid public key data: ' +
          'expected public key in PEM-format", which does not describe the actual problem.',
      )
    })

    test('the certificate message says how to export the key instead', async () => {
      const failure = await failureText(schema, SELF_SIGNED_CERT)
      expect(failure).toBe(
        'Expected a public key, not a certificate. Export the key itself: ' +
          '`openssl pkey -in key.pem -pubout` (or `openssl req -in cert.pem -noout -pubkey`).',
      )
    })
  })

  describe('isResourceId', () => {
    const projectId = Schema.String.check(Validation.isResourceId('project-', 'Project'))

    cases('resourceId', projectId, [
      { value: 'project-abc123', accept: true },
      { value: 'other-abc123', accept: false, because: 'Expected Project ID (should start with "project-")' },
      { value: '', accept: false, because: 'Expected Project ID' },
    ])
  })

  describe('isValidEmail', () => {
    cases('email', Schema.String.check(Validation.isValidEmail), [
      { value: 'kay@example.com', accept: true },
      { value: 'kay+tag@example.co.uk', accept: true },
      { value: 'nope', accept: false, because: 'Invalid email format' },
      { value: 'kay@example', accept: false, because: 'Invalid email format' },
      { value: 'kay@.com', accept: false, because: 'Invalid email format' },
      { value: 'kay example@x.com', accept: false, because: 'Invalid email format' },
      // A space after the TLD fails only via the `$` anchor — the char class after the
      // dot happily accepts punctuation, so trailing junk alone would not discriminate.
      { value: 'kay@example.com x', accept: false, because: 'Invalid email format' },
      { value: 'kay@@x.com', accept: false, because: 'Invalid email format' },
    ])
  })

  describe('isValidUrl', () => {
    cases('url', Schema.String.check(Validation.isValidUrl), [
      { value: 'http://example.com', accept: true },
      { value: 'https://example.com/path?q=1', accept: true },
      { value: 'ftp://example.com', accept: false, because: 'URL must start with http:// or https://' },
      { value: 'example.com', accept: false, because: 'URL must start with http:// or https://' },
      { value: 'http://', accept: false, because: 'URL must start with http:// or https://' },
      { value: 'http:/example.com', accept: false, because: 'URL must start with http:// or https://' },
      // A URL later in the string fails only via the `^` anchor.
      { value: 'see http://example.com', accept: false, because: 'URL must start with http:// or https://' },
    ])
  })

  describe('isPemFormat', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'

    cases('pem', Schema.String.check(Validation.isPemFormat), [
      { value: pem, accept: true },
      { value: '-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----', accept: true },
      { value: '', accept: false, because: 'Expected PEM-encoded data' },
      { value: '-----BEGIN CERTIFICATE-----\nMIIB', accept: false, because: 'Expected PEM-encoded data' },
      { value: 'MIIB\n-----END CERTIFICATE-----', accept: false, because: 'Expected PEM-encoded data' },
    ])

    test('pem: a long value is truncated in the message (a cert must not be echoed whole)', async () => {
      const failure = await failureText(Schema.String.check(Validation.isPemFormat), 'x'.repeat(60))

      expect(failure).toContain('Expected PEM-encoded data')
      expect(failure).not.toContain('x'.repeat(51))
    })
  })

  describe('isValidMountTag', () => {
    test('mountTag: a long value is truncated in the message', async () => {
      const failure = await failureText(Schema.String.check(Validation.isValidMountTag), 'x'.repeat(60))

      expect(failure).toContain('got 60')
      expect(failure).not.toContain('x'.repeat(51))
    })
  })

  describe('ResourceNotFoundError', () => {
    test('carries the tag and the fields callers match on', () => {
      // `_tag` is the contract: `Effect.catchTag('ResourceNotFoundError', …)` matches it,
      // so an `instanceof` assertion (all `tests/resources/actions/*` had) would not
      // notice a mutated tag string.
      const error = new Validation.ResourceNotFoundError({
        resourceType: 'Network',
        name: 'my-network',
        parent: 'project-1',
        message: 'no network named my-network in project-1',
      })

      expect(error._tag).toBe('ResourceNotFoundError')
      expect(error.resourceType).toBe('Network')
      expect(error.parent).toBe('project-1')
      expect(error.message).toBe('no network named my-network in project-1')
    })
  })
})
