/**
 * Read-only environment inventory: everything a probe could have left behind.
 *
 * Written to answer "there are still nodes running, why?" with facts rather than inference: a running
 * node is either a probe that is deliberately mid-run, or a leak from one that has exited. Lists
 * clusters, each cluster's node groups (and their node/VPC state), compute instances (with the owning
 * node group in the name), disks and filesystems.
 *
 *   bun spikes/env-inventory.ts
 */
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformNode from '@effect/platform-node'
import * as AlchemyAuthProvider from 'alchemy/Auth/AuthProvider'
import * as AlchemyCredentials from 'alchemy/Auth/Credentials'
import * as AlchemyProfile from 'alchemy/Auth/Profile'

import * as ComputeGrpcModule from '../modules/api-client/compute.ts'
import * as GrpcTransportModule from '../modules/api-client/GrpcTransport.ts'
import * as Mk8sGrpcModule from '../modules/api-client/mk8s.ts'
import * as NebiusAuthModule from '../modules/AuthProvider.ts'
import * as NebiusCredentialsModule from '../modules/Credentials.ts'
import * as SaBootstrapModule from '../modules/auth/sa-bootstrap.ts'
import * as SaTokenModule from '../modules/auth/sa-token.ts'

const { AuthProviders } = AlchemyAuthProvider
const { ProfileStoreLive } = AlchemyProfile
const { CredentialsStoreLive } = AlchemyCredentials
const { fromAuthProvider } = NebiusCredentialsModule
const { NebiusGrpcTransportLive } = GrpcTransportModule
const { Mk8sGrpcService, Mk8sGrpcServiceLive } = Mk8sGrpcModule
const { ComputeGrpcService, ComputeGrpcServiceLive } = ComputeGrpcModule

const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? 'project-e00eq4g7pr00j746m1fttd'

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

const program = Effect.gen(function* () {
  const mk8s = yield* Mk8sGrpcService
  const compute = yield* ComputeGrpcService

  const clusters = yield* mk8s.cluster.list(PROJECT_ID)
  console.log(`\nclusters in ${PROJECT_ID}: ${clusters.length}`)
  for (const cluster of clusters) {
    const id = cluster.metadata?.id ?? '?'
    console.log(
      `  ${cluster.metadata?.name} (${id}) state=${cluster.status?.state} version=${cluster.status?.controlPlane?.version ?? '?'}`,
    )
    const groups = yield* mk8s.nodeGroup.list(id).pipe(Effect.catch((error) => Effect.sync(() => `ERROR ${String(error)}`)))
    if (typeof groups === 'string') {
      console.log(`    node groups: ${groups}`)
      continue
    }
    for (const group of groups) {
      console.log(
        `    node group ${group.metadata?.name} (${group.metadata?.id}) state=${group.status?.state} ` +
          `target=${group.status?.targetNodeCount} node=${group.status?.nodeCount} ready=${group.status?.readyNodeCount} ` +
          `outdated=${group.status?.outdatedNodeCount} rv=${group.metadata?.resourceVersion}`,
      )
    }
  }

  const instances = yield* compute.instance.list(PROJECT_ID)
  console.log(`\ncompute instances: ${instances.length}`)
  for (const instance of instances) {
    console.log(
      `  ${instance.metadata?.name} (${instance.metadata?.id}) state=${instance.status?.state} ` +
      `created=${instance.metadata?.createdAt?.toISOString?.() ?? instance.metadata?.createdAt}`,
    )
  }

  const disks = yield* compute.disk.list(PROJECT_ID)
  console.log(`\ndisks: ${disks.length}`)
  for (const disk of disks) console.log(`  ${disk.metadata?.name} (${disk.metadata?.id}) state=${disk.status?.state}`)

  const filesystems = yield* compute.filesystem.list(PROJECT_ID)
  console.log(`\nfilesystems: ${filesystems.length}`)
  for (const fs of filesystems) console.log(`  ${fs.metadata?.name} (${fs.metadata?.id}) state=${fs.status?.state}`)
})

const layer = Layer.mergeAll(Mk8sGrpcServiceLive, ComputeGrpcServiceLive).pipe(
  Layer.provide(NebiusGrpcTransportLive.pipe(Layer.provide(fromAuthProvider), Layer.provide(authLayer))),
)
await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped))
