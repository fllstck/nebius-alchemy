import { describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Module from '../../../../modules/resources/iam/v1/static-key.ts'
import * as Iam from '../../../../modules/api-client/iam.ts'
import { resolveProvider, runEffect } from '../../../helpers/provider.ts'
import { mockIamLayer, testConfigLayer, fakeSession, notFoundError, protoMetadata } from '../../../helpers/mocks.ts'

/**
 * StaticKey is a NON-STANDARD API: the token is issued once via `Issue`
 * (there is no `Create`), is only available at issue time, and must be
 * preserved in output — subsequent reads must never overwrite it.
 */

const keyProto = (id: string, name: string, parentId: string, labels: Record<string, string> = {}) => ({
  metadata: protoMetadata(id, name, parentId, labels),
  spec: { account: { serviceAccount: { id: 'serviceaccount-1' } }, service: 'OBSERVABILITY' },
  status: {},
})

describe('Nebius.iam.v1.StaticKey (Issue-only API)', () => {
  test('reconcile issues the key and captures the one-time token when there is no output', async () => {
    const svc = await resolveProvider(Module.NebiusStaticKey.Provider, Module.NebiusStaticKeyProvider)

    const issueCalls: Iam.IssueStaticKeyInput[] = []
    const layer = mockIamLayer({
      staticKey: {
        issue: (req: Iam.IssueStaticKeyInput) => {
          issueCalls.push(req)
          return Effect.succeed({ key: keyProto('key-1', req.metadata.name ?? 'sk', req.metadata.parentId ?? 'project-test-1'), token: 'one-time-token-xyz' })
        },
        get: () => Effect.succeed(keyProto('key-1', 'sk-test', 'project-test-1')),
        delete: () => Effect.void,
      },
    })

    // Creation lives in `reconcile` — NOT in a `precreate` — because `precreate` receives raw props
    // (refs unresolved), so a key declared in the same deploy as its service account failed with
    // `PropsValidationError: Expected string at ["serviceAccountId"]` (see TASKS.md §F). The
    // one-time token capture is identical here: it rides on the `Issue` response. `Object.hasOwn`
    // rather than `svc.precreate` — the latter is an unbound-method lint error.
    expect(Object.hasOwn(svc, 'precreate')).toBe(false)

    const output = await runEffect(
      svc.reconcile({
        id: 'key_abc',
        fqn: 'key_abc',
        instanceId: 'inst',
        news: { serviceAccountId: 'serviceaccount-1', service: 'OBSERVABILITY' },
        output: undefined,
        session: fakeSession,
        bindings: [],
      } as any).pipe(Effect.provide(layer), Effect.provide(testConfigLayer)),
    )

    // The one-time token is captured into output at creation time.
    expect(output.secretKey).toBe('one-time-token-xyz')
    expect(output.accessKey).toBe('key-1')
    expect(output.serviceAccountId).toBe('serviceaccount-1')
    // The API used is `issue`, and the name is auto-generated from the id.
    expect(issueCalls).toHaveLength(1)
    expect(issueCalls[0]!.metadata.name).toBe('sk-key-abc')
  })

  test('reconcile preserves the token from output — reads do not overwrite it', async () => {
    const svc = await resolveProvider(Module.NebiusStaticKey.Provider, Module.NebiusStaticKeyProvider)

    // The get API never returns the token — only the issue response carries it.
    const layer = mockIamLayer({
      staticKey: {
        get: () => Effect.succeed(keyProto('key-1', 'sk-test', 'project-test-1')),
        delete: () => Effect.void,
      },
    })

    const output = await runEffect(
      svc.reconcile({
        id: 'sk_test',
        fqn: 'sk_test',
        instanceId: 'inst',
        news: { serviceAccountId: 'serviceaccount-1', service: 'OBSERVABILITY' },
        olds: { serviceAccountId: 'serviceaccount-1', service: 'OBSERVABILITY' },
        output: { id: 'key-1', secretKey: 'one-time-token-xyz', accessKey: 'key-1', serviceAccountId: 'serviceaccount-1' },
        session: fakeSession,
      } as any).pipe(Effect.provide(layer)),
    )

    expect(output.secretKey).toBe('one-time-token-xyz')
    expect(output.id).toBe('key-1')
  })

  test('reconcile dies with a clear error when the key disappeared (the token is unrecoverable)', async () => {
    const svc = await resolveProvider(Module.NebiusStaticKey.Provider, Module.NebiusStaticKeyProvider)
    // The key is gone: `get` answers NOT_FOUND, which `reconcile` maps to `undefined`.
    const layer = mockIamLayer({
      staticKey: {
        get: () => Effect.fail(notFoundError()),
        delete: () => Effect.void,
      },
    })

    const exit = await runEffect(
      svc.reconcile({
        id: 'sk_test',
        fqn: 'sk_test',
        instanceId: 'inst',
        news: { serviceAccountId: 'serviceaccount-1', service: 'OBSERVABILITY' },
        output: { id: 'key-1', secretKey: 'one-time-token-xyz', accessKey: 'key-1' },
        session: fakeSession,
      } as any).pipe(Effect.provide(layer), Effect.exit),
    )

    // A vanished key cannot be re-issued without losing the token's meaning — die loudly instead.
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) ? exit.cause : '')).toContain('disappeared')
  })
})
