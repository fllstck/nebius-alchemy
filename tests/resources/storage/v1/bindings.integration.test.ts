/**
 * M3: does the V1 access-key service work in-process where V2 fails?
 * Harness: SA + membership, then V1 access-key create (raw api-client).
 */
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Exit from 'effect/Exit'
import * as Test from 'alchemy/Test/Bun'
import * as AlchemyProvider from 'alchemy/Provider'
import { integrationTest } from '../../../helpers/gate'
import * as ServiceAccountResource from '../../../../modules/resources/iam/v1/service-account.ts'
import * as GroupMembershipResource from '../../../../modules/resources/iam/v1/group-membership.ts'
import * as IamGrpc from '../../../../modules/api-client/iam.ts'
import * as GrpcTransport from '../../../../modules/api-client/GrpcTransport.ts'
import * as Credentials from '../../../../modules/Credentials.ts'
import * as AuthProvider from '../../../../modules/AuthProvider.ts'
import * as AlchemyAuth from 'alchemy/Auth'

const EDITORS_GROUP_ID = 'group-e00ee03sdm7ht85b9m'

class MinimalProviders extends AlchemyProvider.ProviderCollection<MinimalProviders>()('Nebius') {}
const minimalResources = AlchemyProvider.collection([
  ServiceAccountResource.NebiusServiceAccount,
  GroupMembershipResource.NebiusGroupMembership,
])
const minimalProviders = Layer.effect(MinimalProviders, minimalResources)
  .pipe(
    Layer.provideMerge(ServiceAccountResource.NebiusServiceAccountProvider),
    Layer.provideMerge(GroupMembershipResource.NebiusGroupMembershipProvider),
  )
  .pipe(
    Layer.provideMerge(IamGrpc.IamGrpcServiceLive),
    Layer.provideMerge(GrpcTransport.NebiusGrpcTransportLive),
    Layer.provideMerge(Credentials.fromAuthProvider),
    Layer.provideMerge(AuthProvider.NebiusAuth),
  )
  .pipe(
    Layer.provideMerge(AlchemyAuth.ProfileLive),
    Layer.provideMerge(AlchemyAuth.CredentialsStoreLive),
    Layer.orDie,
  )

const { test } = Test.make({
  // oxlint-disable-next-line no-explicit-any
  providers: minimalProviders as any,
})

integrationTest(
  test.provider,
  'V1: v1 access-key create in harness',
  (stack) =>
    Effect.gen(function* () {
      const sa = yield* stack.deploy(
        ServiceAccountResource.NebiusServiceAccount('V1SA', { description: 'v1test' }),
      )
      console.log(`[V1] SA id: ${sa.id}`)
      yield* stack.deploy(
        GroupMembershipResource.NebiusGroupMembership('V1Membership', {
          parentId: EDITORS_GROUP_ID as never,
          memberId: sa.id as never,
        }),
      )
      console.log('[V1] MEMBERSHIP OK')

      const iam = yield* IamGrpc.IamGrpcService
      const parentId = process.env.NEBIUS_PROJECT_ID!
      const v1Result = yield* Effect.exit(
        iam.accessKey.create({
          metadata: {
            parentId,
            name: `v1-${Date.now().toString(36)}`,
          },
          spec: {
            account: { serviceAccount: { id: sa.id } },
            description: 'v1test',
          },
        } as never),
      )
      if (Exit.isFailure(v1Result)) {
        console.log(`[V1] v1 create failed: ${String(v1Result.cause).slice(0, 160)}`)
      } else {
        console.log(`[V1] v1 create OK: ${v1Result.value.metadata?.id}`)
      }
      console.log(`[V1] KEEPING: ${sa.id}`)
    }),
  { timeout: 120_000 },
)
