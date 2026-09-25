import { describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Module from '../../../../modules/resources/iam/v1/static-key.ts'
import * as Iam from '../../../../modules/api-client/iam.ts'
import { resolveProvider, runEffect } from '../../../helpers/provider.ts'
import { mockIamLayer, stackLayer, testConfigLayer, fakeSession, notFoundError, protoMetadata } from '../../../helpers/mocks.ts'

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
    const layer = Layer.mergeAll(
      mockIamLayer({
        staticKey: {
          issue: (req: Iam.IssueStaticKeyInput) => {
            issueCalls.push(req)
            return Effect.succeed({ key: keyProto('key-1', req.metadata.name ?? 'sk', req.metadata.parentId ?? 'project-test-1'), token: 'one-time-token-xyz' })
          },
          get: () => Effect.succeed(keyProto('key-1', 'sk-test', 'project-test-1')),
          delete: () => Effect.void,
        },
      }),
      // `createInternalTags` reads the Stack and Stage services.
      stackLayer,
    )

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
    // Ownership tags ride on the issue request: `list` is project-scoped, and nuke deletes every
    // target a provider's `list` returns, so a key with no `alchemy::` label would either be invisible
    // (withheld by the default filter) or — worse, without the filter — a foreign credential nuke
    // would delete. This is the half of R-21 that makes the project-scoped list safe.
    expect(issueCalls[0]!.metadata.labels).toMatchObject({ 'alchemy::id': 'key_abc' })
    expect(Object.keys(issueCalls[0]!.metadata.labels ?? {})).toContain('alchemy::stack')
    expect(Object.keys(issueCalls[0]!.metadata.labels ?? {})).toContain('alchemy::stage')
    // …and never a service account as the container (the API refuses `nid` type `serviceaccount`).
    expect(issueCalls[0]!.metadata.parentId).toBe('project-test-1')
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

  /**
   * R-21, pinned where the API's answer is *not* the authority: the parent this provider sends.
   * The API semantics themselves are pinned by `spikes/static-key-parent-probe.ts` (a unit test
   * cannot invent them), which measured that `Issue` refuses a `serviceaccount` container with
   * `3 INVALID_ARGUMENT: Expected type of nid should be one of project, aiproject, tractotenant,
   * but found serviceaccount` and that `list(SA)` returns nothing while `list(PROJECT)` returns the
   * key. This test exists because the fan-out that contradicted that measurement was reachable only
   * by reading the source: `nuke` enumerates `list`, and the wrong parent there is silent.
   */
  test('list enumerates keys by PROJECT, never by service account', async () => {
    const svc = await resolveProvider(Module.NebiusStaticKey.Provider, Module.NebiusStaticKeyProvider)

    const listParents: string[] = []
    const saListCalls: string[] = []
    const layer = Layer.mergeAll(
      mockIamLayer({
        project: { list: () => Effect.succeed([{ metadata: { id: 'project-test-1', name: 'test-project' } }]) },
        serviceAccount: {
          list: (parentId: string) => {
            saListCalls.push(parentId)
            return Effect.succeed([])
          },
        },
        staticKey: {
          list: (parentId: string) => {
            listParents.push(parentId)
            return Effect.succeed([keyProto('statickey-1', 'sk-test', 'project-test-1', { 'alchemy::id': 'sk-test' })])
          },
        },
      }),
      ConfigProvider.layer(ConfigProvider.fromUnknown({ NEBIUS_TENANT_ID: 'tenant-test-1' })),
    )

    const rows = await runEffect(svc.list().pipe(Effect.provide(layer)))

    expect(listParents).toEqual(['project-test-1'])
    // The project → SA → key fan-out is gone: it could never see a key this provider issued.
    expect(saListCalls).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('statickey-1')
  })
})
