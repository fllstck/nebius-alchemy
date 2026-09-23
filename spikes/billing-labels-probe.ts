/**
 * Does `billing/v1 PricingPolicy` persist `metadata.labels` at all?
 *
 * Found live (2026-09-24) by `pricing-policy.integration.test.ts`: the provider sends its ownership tags
 * on create (as every provider here does, and `Factory.makeCrudRead` checks them through
 * `AlchemyTags.hasAlchemyTags`), and the policy read back with an **empty** labels map. If the service
 * simply does not store labels, then this resource can never report itself as owned — every `read`
 * returns `Unowned`, which changes adoption/nuke behaviour and has to be a documented decision rather
 * than a silent surprise.
 *
 *   bun spikes/billing-labels-probe.ts
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'

import * as BillingGrpcModule from '../modules/api-client/billing.ts'
import * as GrpcTransportModule from '../modules/api-client/GrpcTransport.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule
const { BillingGrpcService, BillingGrpcServiceLive } = BillingGrpcModule

const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'
const NAME = 'alchemy-billing-labels-probe'
/** The shape the providers actually send: internal tags plus user labels. */
const LABELS = { 'alchemy::id': 'probe-id', 'alchemy::stack': 'probe-stack', user: 'label' }

const authLayer = Layer.mergeAll(ProfileStoreLive, NebiusAuthModule.NebiusAuth).pipe(
  Layer.provide(CredentialsStoreLive),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(AuthProviders, {}),
      ConfigProvider.layer(ConfigProvider.fromUnknown({})),
      PlatformNode.NodeServices.layer,
      SaTokenModule.SaTokenMinterLive,
      SaBootstrapModule.SaBootstrapLive,
    ),
  ),
)

const log = (label: string, value: unknown) =>
  console.log(`\n== ${label} ==\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)

const program = Effect.gen(function* () {
  const billing = yield* BillingGrpcService

  const existing = yield* billing.pricingPolicy.list(PROJECT_ID)
  if (existing.length > 0) {
    console.error('ABORT — pricing policies already exist; the environment is not clean.')
    return
  }

  yield* billing.pricingPolicy.create({
    metadata: { parentId: PROJECT_ID, name: NAME, labels: LABELS },
    spec: { computeInstanceSpec: { v1: { platform: 'gpu-h100-sxm' } }, pricing: { maxPriceV1: { maxPrice: '3.000' } } },
  })
  const created = yield* billing.pricingPolicy.getByName({ parentId: PROJECT_ID, name: NAME })
  log('after create with labels', {
    id: created.metadata?.id,
    labelsSent: LABELS,
    labelsStored: created.metadata?.labels ?? '(none)',
  })

  // A second read a moment later, in case labels land asynchronously.
  yield* Effect.sleep('5 seconds')
  const reread = yield* billing.pricingPolicy.get(created.metadata!.id)
  log('re-read 5 s later', { labelsStored: reread.metadata?.labels ?? '(none)' })

  yield* billing.pricingPolicy.delete(created.metadata!.id)
  console.log('cleanup — policy deleted')

  yield* Effect.sleep('3 seconds')
  const remaining = yield* billing.pricingPolicy.list(PROJECT_ID)
  log('POSTFLIGHT', { pricingPolicies: remaining.length })
})

const layer = BillingGrpcServiceLive.pipe(
  Layer.provide(NebiusGrpcTransportLive.pipe(Layer.provide(fromAuthProvider), Layer.provide(authLayer))),
)
await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
