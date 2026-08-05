import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'
import { integrationTest } from '../../../helpers/gate'

const { test } = Test.make({ providers: Nebius.providers() as any })

integrationTest(test.provider, 'Nebius.storage.v1.Bucket lifecycle', (stack) =>
  Effect.gen(function* () {
    const created = yield* stack.deploy(
      Nebius.storage.Bucket('LifecycleTest', {
        versioningPolicy: 'DISABLED',
        defaultStorageClass: 'STANDARD',
        objectAuditLogging: 'NONE',
        forceStorageClass: false,
      }),
    )

    expect(created.id).toBeDefined()
    expect(typeof created.id).toBe('string')
    expect(created.name).toBeDefined()
    expect(created.state).toBe('ACTIVE')
    expect(created.versioningPolicy).toBe('DISABLED')

    // --- Update ---
    const updated = yield* stack.deploy(
      Nebius.storage.Bucket('LifecycleTest', {
        versioningPolicy: 'ENABLED',
        defaultStorageClass: 'STANDARD',
        objectAuditLogging: 'NONE',
        forceStorageClass: true,
      }),
    )

    expect(updated.id).toBe(created.id)
    expect(updated.versioningPolicy).toBe('ENABLED')
  }).pipe(
    Effect.ensuring(stack.destroy().pipe(
      Effect.tapError((e) => Effect.logError(`[cleanup] destroy failed: ${String(e)}`)),
      Effect.ignore,
    )),
  ),
  { timeout: 120_000 },
)
