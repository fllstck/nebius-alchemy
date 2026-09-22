import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import { SELF_SIGNED_CERT } from '../../../helpers/fixtures.ts'
import { integrationTest } from '../../../helpers/gate.ts'



integrationTest(
  test.provider,
  'Nebius.iam.v1.FederationCertificate lifecycle', (stack) =>
  Effect.gen(function* () {
    const fed = yield* stack.deploy(
      Nebius.iam.Federation('CertTestFed', {
        samlSettings: {
          idpIssuer: 'https://cert-test.example.com',
          ssoUrl: 'https://cert-test.example.com/sso',
        },
      }),
    )

    const cert = yield* stack.deploy(
      Nebius.iam.FederationCertificate('LifecycleTest', {
        parentId: fed.id as never,
        description: 'Alchemy integration test cert',
        data: SELF_SIGNED_CERT,
      }),
    )

    expect(cert.id).toBeDefined()
    expect(typeof cert.id).toBe('string')
    expect(cert.description).toBe('Alchemy integration test cert')
  }).pipe(safeDestroy(stack)),
  { timeout: 180_000 },
)
