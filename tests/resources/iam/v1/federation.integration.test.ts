import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'
import { integrationTest } from '../../../helpers/gate'
import { safeDestroy } from '../../../helpers/cleanup'

const { test } = Test.make({ providers: Nebius.providers() as any })

integrationTest(test.provider, 'Nebius.iam.v1.Federation lifecycle', (stack) =>
  Effect.gen(function* () {
    const fed = yield* stack.deploy(
      Nebius.iam.Federation('LifecycleTest', {
        samlSettings: {
          idpIssuer: 'https://test-idp.example.com',
          ssoUrl: 'https://test-idp.example.com/sso',
          forceAuthn: false,
        },
        userAccountAutoCreation: true,
      }),
    )

    expect(fed.id).toBeDefined()
    expect(typeof fed.id).toBe('string')
    expect(fed.name).toBeDefined()
    expect(fed.state).toBe('ACTIVE')
  }).pipe(
    safeDestroy(stack),
  ),
  { timeout: 120_000 },
)
