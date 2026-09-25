import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import Long from 'long'
import { ClusterAdapter, type ClusterAdapterService } from 'alchemy/Kubernetes/ClusterAdapter'
import type { Connection } from 'alchemy/Kubernetes/Connection'

import * as Module from '../../../../modules/resources/mk8s/v1/kubernetes-adapter.ts'
import { requireClusterTransport } from '../../../../modules/resources/mk8s/v1/kubernetes-adapter.ts'
import * as SchemaModule from '../../../../modules/resources/mk8s/v1/cluster.schema.ts'
import * as NebiusCredentialsModule from '../../../../modules/Credentials.ts'
import * as Ids from '../../../../modules/resources/mk8s/v1/ids.ts'
import type { GrpcError } from '../../../../modules/api-client/grpc-utils.ts'
import type { Cluster } from '../../../../schemas/nebius/mk8s/v1/cluster.ts'
import { ClusterStatus_State } from '../../../../schemas/nebius/mk8s/v1/cluster.ts'
import { mockMk8sLayer, notFoundError, protoMetadata } from '../../../helpers/mocks.ts'
import { runEffect } from '../../../helpers/provider.ts'

const { describe, expect, test } = BunTest

const CLUSTER_ID = 'mk8scluster-1'
// The `nebius-mk8s` auth descriptor carries a **branded** cluster id (AGENTS.md
// §"Branded IDs"), so `Connection` literals must brand at the boundary.
const CLUSTER = Ids.ClusterId.make(CLUSTER_ID)
const PEM = '-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----'
const B64_CA = Buffer.from(PEM).toString('base64')

/** A `NebiusCredentials` layer minting a fixed token. */
const credsLayer = Layer.succeed(
  NebiusCredentialsModule.NebiusCredentials,
  Effect.succeed({ apiKey: Redacted.make('test-token') }),
)

/** A RUNNING cluster with the given endpoint/CA. */
const clusterWith = (
  endpoints: { publicEndpoint?: string; privateEndpoint?: string },
  ca: string,
  state: ClusterStatus_State = ClusterStatus_State.RUNNING,
): Cluster => ({
  metadata: protoMetadata(CLUSTER_ID, 'k8s-test', 'project-test-1'),
  spec: undefined,
  status: {
    state,
    controlPlane: {
      version: '1.36.3-nebius-cp.1',
      etcdClusterSize: Long.fromNumber(1),
      endpoints: { publicEndpoint: endpoints.publicEndpoint ?? '', privateEndpoint: endpoints.privateEndpoint ?? '' },
      auth: { clusterCaCertificate: ca },
    },
    events: [],
    reconciling: false,
  },
})

/** Build the adapter layer over a mock cluster service + fixed credentials. */
const adapterLayer = (cluster: { get: (id: string) => Effect.Effect<Cluster, GrpcError> }) =>
  Module.Mk8sKubernetesAdapter().pipe(
    Layer.provide(mockMk8sLayer({ cluster })),
    Layer.provide(credsLayer),
  )

/** Resolve the adapter service and run its `connect` on `connection`. */
const connect = (layer: Layer.Layer<ClusterAdapterService, never, never>, connection: Connection) =>
  runEffect(
    Effect.gen(function* () {
      const adapter = yield* ClusterAdapter('nebius-mk8s')
      const transport = yield* adapter.connect(connection)
      const headers = yield* transport.headers
      return { transport, headers }
    }).pipe(Effect.provide(layer)),
  )

describe('Nebius.mk8s.ClusterAdapter', () => {
  describe('mk8sConnectionOf', () => {
    test('builds the nebius-mk8s auth descriptor, passthrough endpoint/CA', () => {
      const connection = Module.mk8sConnectionOf({
        clusterId: CLUSTER_ID,
        endpoint: 'https://pu.example.com:443',
        certificateAuthorityData: B64_CA,
      })
      expect(connection.auth).toEqual({ kind: 'nebius-mk8s', clusterId: CLUSTER })
      expect(connection.endpoint).toBe('https://pu.example.com:443')
      expect(connection.certificateAuthorityData).toBe(B64_CA)
    })

    test('omits endpoint/CA when absent — the adapter re-describes', () => {
      const connection = Module.mk8sConnectionOf({ clusterId: CLUSTER_ID })
      expect(connection.endpoint).toBeUndefined()
      expect(connection.certificateAuthorityData).toBeUndefined()
      expect(connection.auth).toEqual({ kind: 'nebius-mk8s', clusterId: CLUSTER })
    })

    test('ClusterAttributes.connection is a general Connection (whole-resource passthrough)', () => {
      // The point of the attribute: `ClusterAttributes` must satisfy
      // `{ connection: Connection }`, so the whole cluster resource can be passed
      // as any `Kubernetes.*` workload's `cluster` prop. This assignment only
      // typechecks when the narrowed `Mk8sConnection` is assignable to the
      // general `Connection`.
      const attrs = SchemaModule.toFriendlyAttributes(clusterWith({ publicEndpoint: 'https://pu.example.com:443' }, PEM))
      const asConnection: Connection = attrs.connection
      expect(asConnection.auth.kind).toBe('nebius-mk8s')
    })
  })

  describe('connect', () => {
    test('uses the carried endpoint/CA and mints the Bearer token (no re-describe)', async () => {
      let gets = 0
      const layer = adapterLayer({
        get: () => {
          gets += 1
          return Effect.succeed(clusterWith({ publicEndpoint: 'https://pu.example.com:443' }, PEM))
        },
      })
      const result = await connect(layer, {
        endpoint: 'https://pu.example.com:443',
        certificateAuthorityData: B64_CA,
        auth: { kind: 'nebius-mk8s', clusterId: CLUSTER },
      })
      expect(gets).toBe(0)
      expect(result.transport.endpoint).toBe('https://pu.example.com:443')
      expect(result.transport.certificateAuthorityData).toBe(B64_CA)
      expect(result.headers).toEqual({ Authorization: 'Bearer test-token' })
    })

    test('re-describes a connection without endpoint/CA, base64-encoding the PEM', async () => {
      let lastId: string | undefined
      const layer = adapterLayer({
        get: (id) => {
          lastId = id
          return Effect.succeed(clusterWith({ publicEndpoint: 'https://pu.example.com:443' }, PEM))
        },
      })
      const result = await connect(layer, { auth: { kind: 'nebius-mk8s', clusterId: CLUSTER } })
      expect(lastId).toBe(CLUSTER_ID)
      expect(result.transport.endpoint).toBe('https://pu.example.com:443')
      // The wire hands back PEM; the transport's CA is base64.
      expect(result.transport.certificateAuthorityData).toBe(B64_CA)
      expect(result.headers).toEqual({ Authorization: 'Bearer test-token' })
    })

    test('prefers the public endpoint; falls back to private', async () => {
      const onlyPrivate = await connect(
        adapterLayer({
          get: () =>
            Effect.succeed(clusterWith({ privateEndpoint: 'https://pr.example.com:443' }, PEM)),
        }),
        { auth: { kind: 'nebius-mk8s', clusterId: CLUSTER } },
      )
      expect(onlyPrivate.transport.endpoint).toBe('https://pr.example.com:443')

      const both = await connect(
        adapterLayer({
          get: () =>
            Effect.succeed(
              clusterWith(
                { publicEndpoint: 'https://pu.example.com:443', privateEndpoint: 'https://pr.example.com:443' },
                PEM,
              ),
            ),
        }),
        { auth: { kind: 'nebius-mk8s', clusterId: CLUSTER } },
      )
      expect(both.transport.endpoint).toBe('https://pu.example.com:443')
    })

    test('NOT_FOUND answers ClusterNotFoundError (in-cluster workloads are gone)', async () => {
      const layer = adapterLayer({ get: () => Effect.fail(notFoundError()) })
      const error = await runEffect(
        Effect.gen(function* () {
          const adapter: ClusterAdapterService = yield* ClusterAdapter('nebius-mk8s')
          return yield* adapter.connect({ auth: { kind: 'nebius-mk8s', clusterId: CLUSTER } })
        }).pipe(
          Effect.provide(layer),
          Effect.flip,
        ),
      )
      expect(error).toMatchObject({ _tag: 'Kubernetes.ClusterNotFoundError' })
    })

    test('a DELETING cluster answers ClusterNotFoundError too', async () => {
      const layer = adapterLayer({
        get: () =>
          Effect.succeed(
            clusterWith({ publicEndpoint: 'https://pu.example.com:443' }, PEM, ClusterStatus_State.DELETING),
          ),
      })
      const error = await runEffect(
        Effect.gen(function* () {
          const adapter: ClusterAdapterService = yield* ClusterAdapter('nebius-mk8s')
          return yield* adapter.connect({ auth: { kind: 'nebius-mk8s', clusterId: CLUSTER } })
        }).pipe(
          Effect.provide(layer),
          Effect.flip,
        ),
      )
      expect(error).toMatchObject({ _tag: 'Kubernetes.ClusterNotFoundError' })
    })

    test('a cluster with no endpoint/CA yet fails with ClusterNotReadyError, catchable by tag', async () => {
      const layer = adapterLayer({
        get: () => Effect.succeed(clusterWith({}, '')),
      })
      const error = await runEffect(
        Effect.gen(function* () {
          const adapter: ClusterAdapterService = yield* ClusterAdapter('nebius-mk8s')
          return yield* adapter.connect({ auth: { kind: 'nebius-mk8s', clusterId: CLUSTER } })
        }).pipe(
          Effect.provide(layer),
          Effect.flip,
        ),
      )
      expect(String(error)).toContain('no endpoint or certificate authority yet')
      // The point of R-07: the tag is the discriminator, so a caller can tell “still creating” from
      // "gone" — and this is what pins it (the old plain `Error` matched nothing).
      expect(error).toMatchObject({ _tag: 'ClusterNotReadyError', clusterId: CLUSTER })
    })

    test('ClusterNotReadyError is recoverable with Effect.catchTag (the R-07 contract)', async () => {
      // Exercised through `requireClusterTransport`, which is where the tagged channel is *declared*:
      // alchemy's `ClusterAdapterService.connect` types its error as `ClusterNotFoundError | Error`, so
      // at that boundary the tag is structurally blurred (`Error` carries no `_tag` for `catchTag` to
      // discriminate). The capability R-07 asks for exists in the typed helper `connect` itself uses.
      const recovered = await runEffect(
        requireClusterTransport(Ids.ClusterId.make(CLUSTER), { endpoint: 'https://cp', certificateAuthorityData: undefined }).pipe(
          Effect.catchTag('ClusterNotReadyError', (error) => Effect.succeed(`retry ${error.clusterId}`)),
        ),
      )

      expect(recovered).toBe(`retry ${CLUSTER}`)
    })
  })
})
