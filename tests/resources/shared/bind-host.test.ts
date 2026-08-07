import { afterEach, describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import type { Worker } from 'alchemy/Cloudflare/Workers'
import * as BindHost from '../../../modules/resources/shared/bind-host.ts'

/** A minimal Worker-shaped host that records `bind` calls instead of registering. */
const makeMockHost = () => {
  const calls: Array<{ sid: string; data: unknown }> = []
  const host = {
    bind: (sid: string, data: unknown) => {
      calls.push({ sid, data })
      return Effect.void
    },
  } as unknown as Worker
  return { host, calls }
}

describe('bind-host', () => {
  afterEach(() => {
    // Tests mutate the phase guard global — always restore it.
    delete globalThis.__ALCHEMY_RUNTIME__
  })

  describe('envToWorkerBindings', () => {
    test('plain strings map to plain_text bindings', () => {
      expect(BindHost.envToWorkerBindings({ NEBIUS_BUCKET_NAME: 'my-bucket' })).toEqual([
        { type: 'plain_text', name: 'NEBIUS_BUCKET_NAME', text: 'my-bucket' },
      ])
    })

    test('direct Redacted values map to secret_text with the value UNWRAPPED (the worker provider does not unwrap host.bind data)', () => {
      const bindings = BindHost.envToWorkerBindings({ NEBIUS_SECRET_ACCESS_KEY: Redacted.make('s3cr3t') })
      expect(bindings).toHaveLength(1)
      const binding = bindings[0]!
      expect(binding.type).toBe('secret_text')
      expect(binding.name).toBe('NEBIUS_SECRET_ACCESS_KEY')
      // The provider maps host.bind items passthrough to the wire, which needs
      // a string — unwrap here (cf. the ScriptStartupError hit: a Redacted/Output
      // object as `text` fails Cloudflare's Go unmarshaler).
      expect(binding.text).toBe('s3cr3t')
    })

    test('secret()-wrapped values map to secret_text, keeping the wrapped value (resolves to a string at apply time)', () => {
      const bindings = BindHost.envToWorkerBindings({
        NEBIUS_ENDPOINT_AUTH_TOKEN: BindHost.secret('tok'),
      })
      expect(bindings).toEqual([
        { type: 'secret_text', name: 'NEBIUS_ENDPOINT_AUTH_TOKEN', text: 'tok' },
      ])
    })

    test('mixed env maps each entry to the right binding type', () => {
      const bindings = BindHost.envToWorkerBindings({
        NEBIUS_S3_ENDPOINT: 'https://storage.eu-north1.nebius.cloud',
        NEBIUS_SECRET_ACCESS_KEY: Redacted.make('s3cr3t'),
        NEBIUS_ACCESS_KEY_ID: 'AKIA123',
      })
      expect(bindings).toEqual([
        { type: 'plain_text', name: 'NEBIUS_S3_ENDPOINT', text: 'https://storage.eu-north1.nebius.cloud' },
        { type: 'secret_text', name: 'NEBIUS_SECRET_ACCESS_KEY', text: 's3cr3t' },
        { type: 'plain_text', name: 'NEBIUS_ACCESS_KEY_ID', text: 'AKIA123' },
      ])
    })

    test('empty env produces no bindings', () => {
      expect(BindHost.envToWorkerBindings({})).toEqual([])
    })
  })

  describe('bindWorkerEnv', () => {
    test('registers plain/secret bindings on the host at deploy time', async () => {
      const { host, calls } = makeMockHost()
      // Deploy phase: the guard is unset (falsy), so registration runs.
      await Effect.runPromise(
        BindHost.bindWorkerEnv(host, 'Nebius.storage.GetObject', {
          NEBIUS_BUCKET_NAME: 'my-bucket',
          NEBIUS_SECRET_ACCESS_KEY: Redacted.make('s3cr3t'),
        }),
      )
      expect(calls).toHaveLength(1)
      expect(calls[0]!.sid).toBe('Nebius.storage.GetObject')
      const data = calls[0]!.data as { bindings: BindHost.EnvBinding[] }
      expect(data.bindings).toEqual([
        { type: 'plain_text', name: 'NEBIUS_BUCKET_NAME', text: 'my-bucket' },
        { type: 'secret_text', name: 'NEBIUS_SECRET_ACCESS_KEY', text: 's3cr3t' },
      ])
    })

    test('is a no-op at runtime (guard folded to true)', async () => {
      const { host, calls } = makeMockHost()
      globalThis.__ALCHEMY_RUNTIME__ = true
      await Effect.runPromise(
        BindHost.bindWorkerEnv(host, 'Nebius.storage.GetObject', {
          NEBIUS_BUCKET_NAME: 'my-bucket',
        }),
      )
      expect(calls).toHaveLength(0)
    })
  })
})
