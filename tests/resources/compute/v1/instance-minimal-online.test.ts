/**
 * Minimal provider-path "time to online" integration test — the direct
 * apples-to-apples counterpart of the Nebius CLI smoke test:
 *
 *   CLI:  SG (ingress TCP 22+8080, egress ANY) → instance on the default
 *         subnet with a dynamic public IP + a tiny cloud-init marker server
 *         on :8080 → probe the marker.
 *
 * This test does the same thing through the Alchemy provider: SG + rules +
 * instance (no service account, no hosted bundle) and measures how long until
 * the marker is served from the public IP. Use it as the baseline when
 * bisecting platform networking behavior (public-IP path, SG propagation).
 *
 * Run (real credentials; SLOW_TESTS-gated):
 *
 *   NEBIUS_SA_ID=... NEBIUS_SA_KEY_ID=... NEBIUS_SA_PRIVATE_KEY_FILE=... \
 *   NEBIUS_TEST_SUBNET_ID=<stable-subnet> SLOW_TESTS=1 \
 *   bun test tests/resources/compute/v1/instance-minimal-online.test.ts
 *
 * `NEBIUS_TEST_SUBNET_ID` should point at a PRE-EXISTING, converged subnet
 * (e.g. the project's default subnet) — freshly-created networks have a
 * known platform-level public-IP convergence delay (10-40+ min). When unset,
 * the test creates a fresh network+subnet (same caveat applies).
 */
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import { Nebius, test } from '../../../helpers/stack.ts'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import * as ComputeGrpc from '../../../../modules/api-client/compute.ts'
import * as VpcGrpc from '../../../../modules/api-client/vpc.ts'
import * as Ids from '../../../../modules/resources/compute/v1/ids.ts'
import * as VpcIds from '../../../../modules/resources/vpc/v1/ids.ts'

/** Stable-subnet override — see the header comment. */
const STABLE_SUBNET_ID = process.env.NEBIUS_TEST_SUBNET_ID

/** Public image family + parent (mirrors the CLI's `--source-image-family`). */
const IMAGE_FAMILY = process.env.NEBIUS_TEST_IMAGE_FAMILY ?? 'ubuntu24.04-driverless'
const PUBLIC_IMAGES_PARENT = process.env.NEBIUS_PUBLIC_IMAGES_PARENT_ID ?? 'project-e00public-images'

/** Resolve a subnet's network id (for the SG when reusing a stable subnet). */
const subnetNetworkId = (subnetId: string) =>
  Effect.gen(function* () {
    const vpc = yield* VpcGrpc.VpcGrpcService
    const subnet = yield* vpc.subnet.get(subnetId)
    const networkId = subnet.spec?.networkId
    if (!networkId) {
      return yield* Effect.die(new Error(`Stable subnet ${subnetId} has no networkId`))
    }
    return networkId as VpcIds.NetworkId
  })

integrationTest(
  test.provider,
  'Nebius.compute.v1.Instance minimal online — SG + public IP + marker probe (CLI-test counterpart)',
  (stack) =>
    Effect.gen(function* () {
      const t0 = Date.now()

      // Resolve the boot image the same way the CLI resolves the family.
      const compute = yield* ComputeGrpc.ComputeGrpcService
      const image = yield* compute.image.getLatestByFamily({ parentId: PUBLIC_IMAGES_PARENT, imageFamily: IMAGE_FAMILY })
      const imageId = Ids.ImageId.make(image.metadata!.id)
      console.log(`[minimal-online] image ${IMAGE_FAMILY} → ${imageId}`)

      // Stage 1: SG + rules (fresh, provider-created — mirrors the CLI script
      // that created `cli-online-test-sg` with the same rule shape).
      const { subnetId, sgId } = yield* stack.deploy(
        Effect.gen(function* () {
          const networkId =
            STABLE_SUBNET_ID === undefined
              ? (yield* Nebius.vpc.Network('MinimalOnline-Network', {})).id
              : yield* subnetNetworkId(STABLE_SUBNET_ID)
          const subnetId = STABLE_SUBNET_ID ?? (yield* Nebius.vpc.Subnet('MinimalOnline-Subnet', { networkId })).id
          const sg = yield* Nebius.vpc.SecurityGroup('MinimalOnline-SG', { networkId })
          yield* Nebius.vpc.SecurityRule('MinimalOnline-SG-Ingress', {
            parentId: sg.id,
            direction: 'INGRESS',
            protocol: 'TCP',
            access: 'ALLOW',
            ingress: { sourceCidrs: ['0.0.0.0/0'], destinationPorts: [22, 8080] },
          })
          yield* Nebius.vpc.SecurityRule('MinimalOnline-SG-Egress', {
            parentId: sg.id,
            direction: 'EGRESS',
            protocol: 'ANY',
            access: 'ALLOW',
            egress: { destinationCidrs: ['0.0.0.0/0'] },
          })
          return { networkId, subnetId, sgId: sg.id }
        }),
      )
      console.log(`[minimal-online] SG+rules deployed after ${((Date.now() - t0) / 1000).toFixed(0)}s`)

      // Stage 2: the instance (byte-identical spec shape to the CLI test —
      // no SA, marker cloud-init on :8080, dynamic public IP).
      const { instance } = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* Nebius.compute.Instance('MinimalOnlineInstance', {
            resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
            bootDisk: {
              attachMode: 'READ_WRITE',
              managedDisk: {
                name: 'minimal-online-boot',
                spec: { sizeGibibytes: 64, type: 'NETWORK_SSD', sourceImageId: imageId },
              },
            },
            networkInterfaces: [
              {
                subnetId,
                name: 'eth0',
                ipAddress: { allocationId: '' },
                publicIpAddress: { static: false },
                securityGroups: [{ id: sgId }],
              },
            ],
            serviceAccountId: '',
            cloudInitUserData: `#cloud-config
write_files:
  - path: /root/online-marker
    content: |
      online-marker-written
runcmd:
  - [ sh, -c, "cd /root && nohup python3 -m http.server 8080 >/tmp/http.log 2>&1 & echo $! > /tmp/http.pid" ]
`,
          })
          return { instance }
        }),
      )
      const t1 = Date.now()
      console.log(`[minimal-online] deploy returned state=${instance.state} after ${((t1 - t0) / 1000).toFixed(0)}s`)
      expect(instance.id).toBeDefined()

      // Live status → public IP (the CLI test reads it from `instance get`).
      const live = yield* compute.instance.get(instance.id)
      const publicIp = live.status?.networkInterfaces
        ?.map((networkInterface) => networkInterface.publicIpAddress?.address?.split('/')[0])
        .find((address) => address)
      console.log(`[minimal-online] live state=${live.status?.state} publicIp=${publicIp} after ${((Date.now() - t0) / 1000).toFixed(0)}s`)
      expect(publicIp).toBeDefined()

      // Probe the marker until it serves (generous deadline; logs the timing).
      let body: string | undefined
      let onlineAt = 0
      while (Date.now() - t0 < 20 * 60 * 1000) {
        body = yield* Effect.tryPromise(async () => {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 5_000)
          try {
            const res = await fetch(`http://${publicIp}:8080/online-marker`, { signal: controller.signal })
            return res.ok ? await res.text() : undefined
          } catch {
            return undefined
          } finally {
            clearTimeout(timer)
          }
        })
        if (body !== undefined) {
          onlineAt = Date.now() - t0
          break
        }
        yield* Effect.sleep('10 seconds')
      }
      console.log(`[minimal-online] HTTP 8080 marker=${body ?? 'NEVER'} online after ${(onlineAt / 1000).toFixed(0)}s`)
      console.log(`[minimal-online] SUMMARY: provider-path minimal instance online in ${(onlineAt / 1000).toFixed(0)}s`)
      expect(body).toContain('online-marker-written')
    }).pipe(safeDestroy(stack)),
  { timeout: 25 * 60 * 1000 },
)
