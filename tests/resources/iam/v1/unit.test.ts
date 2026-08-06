import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as ServiceAccountModule from '../../../../modules/resources/iam/v1/service-account.ts'
import * as ServiceAccountSchema from '../../../../modules/resources/iam/v1/service-account.schema.ts'
import * as StaticKeyModule from '../../../../modules/resources/iam/v1/static-key.ts'
import * as StaticKeySchema from '../../../../modules/resources/iam/v1/static-key.schema.ts'
import * as AccessKeyModule from '../../../../modules/resources/iam/v2/access-key.ts'
import * as AccessKeySchema from '../../../../modules/resources/iam/v2/access-key.schema.ts'
import { resolveProvider, runDiff, runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

describe('Nebius.iam.v1.ServiceAccount', () => {
  test('NebiusServiceAccount resource constructor is defined', () => {
    expect(ServiceAccountModule.NebiusServiceAccount).toBeDefined()
    expect(typeof ServiceAccountModule.NebiusServiceAccount).toBe('function')
  })

  test('NebiusServiceAccountProvider is defined', () => {
    expect(ServiceAccountModule.NebiusServiceAccountProvider).toBeDefined()
  })

  describe('diff', () => {
    test('name change requires replace', async () => {
      const svc = await resolveProvider(ServiceAccountModule.NebiusServiceAccount.Provider, ServiceAccountModule.NebiusServiceAccountProvider)
      expect(await runDiff(svc, { name: 'new-sa' }, { name: 'old-sa' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(ServiceAccountModule.NebiusServiceAccount.Provider, ServiceAccountModule.NebiusServiceAccountProvider)
      expect(await runDiff(svc, { name: 'my-sa', description: 'd' }, { name: 'my-sa', description: 'd' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        ServiceAccountSchema.validateServiceAccountProps({ name: 'my-sa', description: 'd' }),
      )
      expect(result.name).toBe('my-sa')
    })

    test('rejects non-DNS-compliant name', async () => {
      const result = await runEffect(
        ServiceAccountSchema.validateServiceAccountProps({ name: 'Bad SA' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})

describe('Nebius.iam.v1.StaticKey', () => {
  test('NebiusStaticKey resource constructor is defined', () => {
    expect(StaticKeyModule.NebiusStaticKey).toBeDefined()
    expect(typeof StaticKeyModule.NebiusStaticKey).toBe('function')
  })

  test('NebiusStaticKeyProvider is defined', () => {
    expect(StaticKeyModule.NebiusStaticKeyProvider).toBeDefined()
  })

  describe('diff', () => {
    test('serviceAccountId change requires replace', async () => {
      const svc = await resolveProvider(StaticKeyModule.NebiusStaticKey.Provider, StaticKeyModule.NebiusStaticKeyProvider)
      expect(await runDiff(svc, { serviceAccountId: 'sa-2' }, { serviceAccountId: 'sa-1' })).toEqual({ action: 'replace' })
    })

    test('service change requires replace', async () => {
      const svc = await resolveProvider(StaticKeyModule.NebiusStaticKey.Provider, StaticKeyModule.NebiusStaticKeyProvider)
      expect(await runDiff(svc, { service: 'AI' }, { service: 'OBSERVABILITY' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(StaticKeyModule.NebiusStaticKey.Provider, StaticKeyModule.NebiusStaticKeyProvider)
      expect(await runDiff(svc, { serviceAccountId: 'sa-1', service: 'OBSERVABILITY' }, { serviceAccountId: 'sa-1', service: 'OBSERVABILITY' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        StaticKeySchema.validateStaticKeyProps({
          serviceAccountId: 'serviceaccount-abc123' as StaticKeySchema.StaticKeyProps['serviceAccountId'],
          service: 'OBSERVABILITY',
        }),
      )
      expect(result.serviceAccountId).toBe('serviceaccount-abc123')
    })

    test('rejects props without serviceAccountId', async () => {
      const result = await runEffect(
        StaticKeySchema.validateStaticKeyProps({ service: 'OBSERVABILITY' }).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})

describe('Nebius.iam.v2.AccessKey', () => {
  test('NebiusAccessKey resource constructor is defined', () => {
    expect(AccessKeyModule.NebiusAccessKey).toBeDefined()
    expect(typeof AccessKeyModule.NebiusAccessKey).toBe('function')
  })

  test('NebiusAccessKeyProvider is defined', () => {
    expect(AccessKeyModule.NebiusAccessKeyProvider).toBeDefined()
  })

  describe('diff', () => {
    test('serviceAccountId change requires replace', async () => {
      const svc = await resolveProvider(AccessKeyModule.NebiusAccessKey.Provider, AccessKeyModule.NebiusAccessKeyProvider)
      expect(await runDiff(svc, { serviceAccountId: 'sa-2' }, { serviceAccountId: 'sa-1' })).toEqual({ action: 'replace' })
    })

    test('secretDeliveryMode change requires replace (immutable)', async () => {
      const svc = await resolveProvider(AccessKeyModule.NebiusAccessKey.Provider, AccessKeyModule.NebiusAccessKeyProvider)
      expect(await runDiff(svc, { serviceAccountId: 'sa-1', secretDeliveryMode: 'INLINE' }, { serviceAccountId: 'sa-1', secretDeliveryMode: 'ON_DEMAND' })).toEqual({ action: 'replace' })
    })

    test('no change is a noop', async () => {
      const svc = await resolveProvider(AccessKeyModule.NebiusAccessKey.Provider, AccessKeyModule.NebiusAccessKeyProvider)
      expect(await runDiff(svc, { serviceAccountId: 'sa-1' }, { serviceAccountId: 'sa-1' })).toBeUndefined()
    })
  })

  describe('validation', () => {
    test('accepts valid props', async () => {
      const result = await runEffect(
        AccessKeySchema.validateAccessKeyProps({
          serviceAccountId: 'serviceaccount-abc123' as AccessKeySchema.AccessKeyProps['serviceAccountId'],
        }),
      )
      expect(result.serviceAccountId).toBe('serviceaccount-abc123')
    })

    test('rejects props without serviceAccountId', async () => {
      const result = await runEffect(
        AccessKeySchema.validateAccessKeyProps({}).pipe(Effect.flip),
      )
      expect(result._tag).toBe('PropsValidationError')
    })
  })
})
