/**
 * DIAGNOSTIC (temporary, SLOW_TESTS-gated): create a LOW-LEVEL instance via
 * the Alchemy provider with the EXACT same spec as the CLI-created
 * `cli-online-test` instance (same subnet, SG, image, disk size, public-IP
 * config, cloud-init) and measure how long until it is reachable.
 *
 * Compare against the CLI instance: created 09:32:22Z on the recreated
 * default network, SSH+HTTP reachable within ~4 min.
 *
 * Run:  SLOW_TESTS=1 bun test tests/resources/compute/v1/provider-online.test.ts
 */
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import { Nebius, test } from '../../../helpers/stack.ts'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import * as ComputeGrpc from '../../../../modules/api-client/compute.ts'

const SUBNET_ID = 'vpcsubnet-e00rf5t1vkbq0ew96x' // default-subnet (recreated 2026-08-11, converged)
const SG_ID = 'vpcsecuritygroup-e00qw6f6jxrf125e4p' // cli-online-test-sg (ingress 22+8080, egress any)
const IMAGE_ID = 'computeimage-e00ar5w73pjaw67cnp' // ubuntu24.04-driverless.0.2.661.img
const USERDATA = `#cloud-config
write_files:
  - path: /root/online-marker
    content: |
      online-marker-written
runcmd:
  - [ sh, -c, "cd /root && nohup python3 -m http.server 8080 >/tmp/http.log 2>&1 & echo \$! > /tmp/http.pid" ]
`

const probePort = (host: string, port: number, timeoutMs: number) =>
  Effect.tryPromise(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`http://${host}:${port}/online-marker`, { signal: controller.signal })
      if (res.ok) return await res.text()
      return undefined
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  })

integrationTest(
  test.provider,
  'DIAGNOSTIC: provider-path instance online timing (same spec as CLI instance)',
  (stack) =>
    Effect.gen(function* () {
      const t0 = Date.now()
      const { instance } = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* Nebius.compute.Instance('ProviderOnlineTest', {
            resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
            bootDisk: {
              attachMode: 'READ_WRITE',
              managedDisk: {
                name: 'provider-test-boot',
                spec: { sizeGibibytes: 64, type: 'NETWORK_SSD', sourceImageId: IMAGE_ID },
              },
            },
            networkInterfaces: [
              {
                subnetId: SUBNET_ID,
                name: 'eth0',
                ipAddress: { allocationId: '' },
                publicIpAddress: { static: false },
                securityGroups: [{ id: SG_ID }],
              },
            ],
            serviceAccountId: '',
            cloudInitUserData: USERDATA,
          })
          return { instance }
        }),
      )

      const t1 = Date.now()
      console.log(`[diag] deploy returned: state=${instance.state} after ${((t1 - t0) / 1000).toFixed(0)}s`)
      expect(instance.id).toBeDefined()

      // Live status → public IP
      const compute = yield* ComputeGrpc.ComputeGrpcService
      const live = yield* compute.instance.get(instance.id)
      const publicIp = live.status?.networkInterfaces
        ?.map((networkInterface) => networkInterface.publicIpAddress?.address?.split('/')[0])
        .find((address) => address)
      console.log(`[diag] live state=${live.status?.state} publicIp=${publicIp} after ${((Date.now() - t0) / 1000).toFixed(0)}s`)
      expect(publicIp).toBeDefined()

      // Probe 8080 until it serves the marker
      let httpBody: string | undefined
      let httpAt = 0
      while (Date.now() - t0 < 20 * 60 * 1000) {
        httpBody = yield* probePort(publicIp!, 8080, 5000)
        if (httpBody !== undefined) {
          httpAt = Date.now() - t0
          break
        }
        yield* Effect.sleep('10 seconds')
      }
      console.log(
        `[diag] HTTP 8080 marker=${httpBody ?? 'NEVER'} after ${(httpAt / 1000).toFixed(0)}s (t0→online)`,
      )
      console.log(`[diag] SUMMARY: provider-path instance online in ${(httpAt / 1000).toFixed(0)}s; CLI path was <~240s`)
      expect(httpBody).toContain('online-marker-written')
    }).pipe(safeDestroy(stack)),
  { timeout: 25 * 60 * 1000 },
)
