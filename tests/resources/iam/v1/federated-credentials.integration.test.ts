import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import { integrationTest } from '../../../helpers/gate.ts'

const FEDERATED_SUBJECT = 'alchemy-test-subject'

/**
 * FederatedCredentials lifecycle.
 *
 * Filled a real gap: the resource was exercised only *indirectly*, as the helper
 * the storage binding creates for its host identity — never as a resource of its
 * own, so its create/delete paths (and its attribute shape) had no real-infra
 * coverage. Staged like the other lifecycle tests: the service account first (its
 * id becomes concrete state), then the credential referencing it, because a
 * federated credential impersonates an IAM subject.
 */
integrationTest(
  test.provider,
  'Nebius.iam.v1.FederatedCredentials lifecycle',
  (stack) =>
    Effect.gen(function* () {
      // Stage 1 — the impersonation target.
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Nebius.iam.ServiceAccount('FederatedTargetSA', {
            description: 'federated credentials integration test SA',
          })
        }),
      )

      // Stage 2 — the credential itself (re-declare the SA: noop).
      const { credentials } = yield* stack.deploy(
        Effect.gen(function* () {
          const sa = yield* Nebius.iam.ServiceAccount('FederatedTargetSA', {
            description: 'federated credentials integration test SA',
          })
          const credentials = yield* Nebius.iam.FederatedCredentials('LifecycleTest', {
            oidcProvider: { issuerUrl: 'https://oidc.alchemy-test.example.com' },
            federatedSubjectId: FEDERATED_SUBJECT,
            subjectId: sa.id,
          })
          return { credentials }
        }),
      )

      expect(credentials.id).toBeDefined()
      expect(typeof credentials.id).toBe('string')
      expect(credentials.name).toBeDefined()
      expect(credentials.federatedSubjectId).toBe(FEDERATED_SUBJECT)
      console.log(`[FEDERATED] created ${credentials.id}`)
    }).pipe(safeDestroy(stack)),
  { timeout: 180_000 },
)
