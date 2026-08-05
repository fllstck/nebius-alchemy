import { afterEach, describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import type { Worker } from 'alchemy/Cloudflare/Workers'
import * as BindHost from '../../../modules/resources/shared/bind-host'

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
    delete (globalThis as Record<string, unknown>).__ALCHEMY_RUNTIME__
  })

  describe('envToWorkerBindings', () => {
    test('plain strings map to plain_text bindings', () => {
      expect(BindHost.envToWorkerBindings({ NEBIUS_BUCKET_NAME: 'my-bucket' })).toEqual([
        { type: 'plain_text', name: 'NEBIUS_BUCKET_NAME', text: 'my-bucket' },
      ])
    })

    test('Redacted values map to secret_text bindings with unwrapped text', () => {
      expect(
        BindHost.envToWorkerBindings({ NEBIUS_SECRET_ACCESS_KEY: Redacted.make('s3cr3t') }),
      ).toEqual([{ type: 'secret_text', name: 'NEBIUS_SECRET_ACCESS_KEY', text: 's3cr3t' }])
    })

    test('mixed env maps each entry to the right binding type', () => {
      expect(
        BindHost.envToWorkerBindings({
          NEBIUS_S3_ENDPOINT: 'https://storage.eu-north1.nebius.cloud',
          NEBIUS_SECRET_ACCESS_KEY: Redacted.make('s3cr3t'),
          NEBIUS_ACCESS_KEY_ID: 'AKIA123',
        }),
      ).toEqual([
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
      expect(calls[0]!.data).toEqual({
        bindings: [
          { type: 'plain_text', name: 'NEBIUS_BUCKET_NAME', text: 'my-bucket' },
          { type: 'secret_text', name: 'NEBIUS_SECRET_ACCESS_KEY', text: 's3cr3t' },
        ],
      })
    })

    test('is a no-op at runtime (guard folded to true)', async () => {
      const { host, calls } = makeMockHost()
      ;(globalThis as Record<string, unknown>).__ALCHEMY_RUNTIME__ = true
      await Effect.runPromise(
        BindHost.bindWorkerEnv(host, 'Nebius.storage.GetObject', {
          NEBIUS_BUCKET_NAME: 'my-bucket',
        }),
      )
      expect(calls).toHaveLength(0)
    })
  })
})
