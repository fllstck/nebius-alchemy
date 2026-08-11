/**
 * Hosted-instance integration test (SLOW_TESTS-gated): the full pipeline —
 * bundle the fixture program → upload to the per-stack assets bucket →
 * provision a VM → cloud-init fetch + systemd boot → the program serves HTTP
 * with the shipped env → destroy → S3 assets + dedicated fetch key cleaned.
 *
 * Requires real credentials + compute quota (the existing instance lifecycle
 * test has the same requirement). Run:
 *
 *   NEBIUS_API_KEY=... SLOW_TESTS=1 bun test tests/resources/compute/v1/hosted-instance.integration.test.ts
 *
 * The fixture (`tests/fixtures/hosted-instance-program.ts`) reads
 * `HOSTED_TEST_SUBNET_ID` / `HOSTED_TEST_SA_ID` from Config — the test sets
 * them (process.env) before the hosted instance deploys.
 */
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import { Nebius, test } from '../../../helpers/stack.ts'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import * as ComputeGrpc from '../../../../modules/api-client/compute.ts'
import * as StorageGrpc from '../../../../modules/api-client/storage.ts'
import * as IamGrpc from '../../../../modules/api-client/iam.ts'

const PROJECT = process.env.NEBIUS_PROJECT_ID ?? ''
const FIXTURE_MAIN = new URL('../../../fixtures/hosted-instance-program.ts', import.meta.url).href
const INSTANCE_LOGICAL_ID = 'HostedTestInstance'
const FETCH_KEY_NAME = `ak-${`${INSTANCE_LOGICAL_ID}HostedRuntimeKey`.replace(/_/g, '-').toLowerCase().slice(0, 55)}`

/** Poll a URL until it answers 2xx; returns the JSON body. */
const probeJson = async (url: string): Promise<unknown> => {
  const deadline = Date.now() + 5 * 60 * 1000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
      if (response.ok) return await response.json()
    } catch (error) {
      lastError = error
    }
    await Effect.runPromise(Effect.sleep('5 seconds'))
  }
  throw new Error(`Health probe to ${url} never succeeded: ${String(lastError)}`)
}

/**
 * Post-destroy leak verification: the dedicated hosted-runtime fetch key must
 * be gone, and no hosted-assets bucket may survive (the instance's cleanup
 * emptied it, so the stack-owned bucket deletes cleanly).
 */
const verifyAssetsCleanup = Effect.gen(function* () {
  const iam = yield* IamGrpc.IamGrpcService
  const keys = yield* iam.accessKeyV2.list(PROJECT).pipe(Effect.catch(() => Effect.succeed([])))
  expect(keys.some((key) => key.metadata?.name === FETCH_KEY_NAME)).toBe(false)

  const storage = yield* StorageGrpc.StorageGrpcService
  const buckets = yield* storage.bucket.list(PROJECT).pipe(Effect.catch(() => Effect.succeed([])))
  const leakedAssets = buckets.filter((bucket) => bucket.metadata?.name?.includes('hostedassets'))
  expect(leakedAssets).toHaveLength(0)
})

integrationTest(
  test.provider,
  'Nebius.compute.v1.Instance hosted runtime — bundle, boot, serve, clean',
  (stack) =>
    Effect.gen(function* () {
      // Stage 1: network + subnet + the instance's service account + an
      // ingress rule so the health probe can reach the hosted port.
      const { network, subnet, sa, sg } = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* Nebius.vpc.Network('HostedTest-Network', {})
          const subnet = yield* Nebius.vpc.Subnet('HostedTest-Subnet', { networkId: network.id })
          const sa = yield* Nebius.iam.ServiceAccount('HostedTest-SA', {
            description: 'hosted runtime test',
          })
          const sg = yield* Nebius.vpc.SecurityGroup('HostedTest-SG', { networkId: network.id })
          yield* Nebius.vpc.SecurityRule('HostedTest-SG-Rule', {
            parentId: sg.id,
            direction: 'INGRESS',
            protocol: 'TCP',
            access: 'ALLOW',
            ingress: { sourceCidrs: ['0.0.0.0/0'], destinationPorts: [3000] },
          })
          return { network, subnet, sa, sg }
        }),
      )
      expect(network.id).toBeDefined()
      expect(subnet.id).toBeDefined()
      expect(sa.id).toBeDefined()
      expect(sg.id).toBeDefined()

      // Stage 2: re-declare the deps + the hosted instance (main = fixture).
      process.env.HOSTED_TEST_SUBNET_ID = subnet.id
      process.env.HOSTED_TEST_SA_ID = sa.id
      const { instance } = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Nebius.vpc.Network('HostedTest-Network', {})
          yield* Nebius.vpc.Subnet('HostedTest-Subnet', { networkId: network.id })
          yield* Nebius.iam.ServiceAccount('HostedTest-SA', {
            description: 'hosted runtime test',
          })
          const sg = yield* Nebius.vpc.SecurityGroup('HostedTest-SG', { networkId: network.id })
          yield* Nebius.vpc.SecurityRule('HostedTest-SG-Rule', {
            parentId: sg.id,
            direction: 'INGRESS',
            protocol: 'TCP',
            access: 'ALLOW',
            ingress: { sourceCidrs: ['0.0.0.0/0'], destinationPorts: [3000] },
          })
          const instance = yield* Nebius.compute.Instance(INSTANCE_LOGICAL_ID, {
            serviceAccountId: sa.id,
            resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
            bootDisk: {
              attachMode: 'READ_WRITE',
              managedDisk: {
                name: 'boot-disk',
                // Nebius enforces a 64 GiB boot-disk floor — smaller disks
                // hang provisioning (cloud-init never runs).
                spec: { type: 'NETWORK_SSD', sizeGibibytes: 64 },
              },
            },
            networkInterfaces: [
              {
                subnetId: subnet.id,
                name: 'eth0',
                ipAddress: { allocationId: '' },
                publicIpAddress: { static: false },
                securityGroups: [{ id: sg.id }],
              },
            ],
            main: FIXTURE_MAIN,
            port: 3000,
            env: { HOSTED_TEST_ECHO: 'hello-from-env' },
          })
          return { instance }
        }),
      )

      expect(instance.id).toBeDefined()
      expect(instance.state).toBe('RUNNING')
      // Hosted attrs are provider state — assert they persisted.
      expect(instance.runtimeUnitName).toBeDefined()
      expect(instance.assetPrefix).toBeDefined()
      expect(instance.hostedBucketName).toBeDefined()

      // Find the public IP from the live instance status.
      const compute = yield* ComputeGrpc.ComputeGrpcService
      const live = yield* compute.instance.get(instance.id)
      const publicIp = live.status?.networkInterfaces
        ?.map((networkInterface) => networkInterface.publicIpAddress?.address?.split('/')[0])
        .find((address) => address)
      expect(publicIp).toBeDefined()

      // The program serves HTTP on :3000 with the shipped env echoed back —
      // this is the end-to-end proof: bundle shipped, fetched, booted, env
      // file loaded (the deploy's health read-back already probed once).
      const body = (yield* Effect.promise(() => probeJson(`http://${publicIp}:3000/`))) as Record<string, unknown>
      expect(body).toEqual({ ok: true, echo: 'hello-from-env' })
    }).pipe(safeDestroy(stack, verifyAssetsCleanup)),
  { timeout: 10 * 60 * 1000 },
)
