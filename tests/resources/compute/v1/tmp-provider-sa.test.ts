/**
 * DIAGNOSTIC (temporary, SLOW_TESTS-gated): the missing comparison cell —
 * provider-created instance WITH a service account + marker user-data.
 * Minimal test (provider, no SA) worked; hosted e2e (provider, SA, heavy
 * user-data) is filtered. SA alone (CLI instance) worked. This tests whether
 * provider + SA is the trigger.
 */
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import { Nebius, test } from '../../../helpers/stack.ts'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import { runDiskName } from '../../../helpers/run-token.ts'
import * as ComputeGrpc from '../../../../modules/api-client/compute.ts'
import * as Ids from '../../../../modules/resources/compute/v1/ids.ts'
import * as VpcIds from '../../../../modules/resources/vpc/v1/ids.ts'

const SUBNET_ID = 'vpcsubnet-e00rf5t1vkbq0ew96x'
const SA_ID = 'serviceaccount-e00bj4mqzqgbqp8pcj'
const IMAGE_FAMILY = 'ubuntu24.04-driverless'
const PUBLIC_IMAGES_PARENT = 'project-e00public-images'
const DEFAULT_NETWORK = 'vpcnetwork-e00kr4njd4pyt8g8r6' as VpcIds.NetworkId

integrationTest(
  test.provider,
  'DIAG: provider instance + SA + marker (missing cell)',
  (stack) =>
    Effect.gen(function* () {
      const t0 = Date.now()
      const compute = yield* ComputeGrpc.ComputeGrpcService
      const image = yield* compute.image.getLatestByFamily({ parentId: PUBLIC_IMAGES_PARENT, imageFamily: IMAGE_FAMILY })
      const imageId = Ids.ImageId.make(image.metadata!.id)

      const { instance } = yield* stack.deploy(
        Effect.gen(function* () {
          const sg = yield* Nebius.vpc.SecurityGroup('DiagSaSG', { networkId: DEFAULT_NETWORK })
          yield* Nebius.vpc.SecurityRule('DiagSaIngress', {
            parentId: sg.id,
            direction: 'INGRESS',
            protocol: 'TCP',
            access: 'ALLOW',
            ingress: { sourceCidrs: ['0.0.0.0/0'], destinationPorts: [3000] },
          })
          yield* Nebius.vpc.SecurityRule('DiagSaEgress', {
            parentId: sg.id,
            direction: 'EGRESS',
            protocol: 'ANY',
            access: 'ALLOW',
            egress: { destinationCidrs: ['0.0.0.0/0'] },
          })
          const instance = yield* Nebius.compute.Instance('DiagSaInstance', {
            serviceAccountId: SA_ID,
            resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
            bootDisk: {
              attachMode: 'READ_WRITE',
              managedDisk: {
                name: runDiskName('diag-sa-boot'),
                spec: { sizeGibibytes: 64, type: 'NETWORK_SSD', sourceImageId: imageId },
              },
            },
            networkInterfaces: [
              {
                subnetId: SUBNET_ID,
                name: 'eth0',
                ipAddress: { allocationId: '' },
                publicIpAddress: { static: false },
                securityGroups: [{ id: sg.id }],
              },
            ],
            cloudInitUserData: `#cloud-config
write_files:
  - path: /root/online-marker
    content: |
      online-marker-written
runcmd:
  - [ sh, -c, "cd /root && nohup python3 -m http.server 3000 >/tmp/http.log 2>&1 & echo $! > /tmp/http.pid" ]
`,
          })
          return { instance }
        }),
      )
      console.log(`[diag] deploy returned state=${instance.state} after ${((Date.now() - t0) / 1000).toFixed(0)}s`)

      const live = yield* compute.instance.get(instance.id)
      const publicIp = live.status?.networkInterfaces
        ?.map((networkInterface) => networkInterface.publicIpAddress?.address?.split('/')[0])
        .find((address) => address)
      console.log(`[diag] state=${live.status?.state} publicIp=${publicIp} after ${((Date.now() - t0) / 1000).toFixed(0)}s`)
      expect(publicIp).toBeDefined()

      let body: string | undefined
      let onlineAt = 0
      while (Date.now() - t0 < 10 * 60 * 1000) {
        body = yield* Effect.tryPromise(async () => {
          try {
            const res = await fetch(`http://${publicIp}:3000/online-marker`, { signal: AbortSignal.timeout(5_000) })
            return res.ok ? await res.text() : undefined
          } catch {
            return undefined
          }
        })
        if (body !== undefined) {
          onlineAt = Date.now() - t0
          break
        }
        yield* Effect.sleep('10 seconds')
      }
      console.log(`[diag] RESULT: marker=${body ?? 'NEVER'} online after ${(onlineAt / 1000).toFixed(0)}s`)
      expect(body).toContain('online-marker-written')
    }).pipe(safeDestroy(stack)),
  { timeout: 12 * 60 * 1000 },
)
