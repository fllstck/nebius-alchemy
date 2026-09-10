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
import { createHash } from 'node:crypto'
import { expect } from 'bun:test'
import { Nebius, test } from '../../../helpers/stack.ts'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import { S3Client } from '@bradenmacdonald/s3-lite-client'
import { hostIdentity } from '../../../../modules/resources/shared/host-identity.ts'
import * as ComputeGrpc from '../../../../modules/api-client/compute.ts'
import * as VpcGrpc from '../../../../modules/api-client/vpc.ts'
import { runDiskName } from '../../../helpers/run-token.ts'
import * as StorageGrpc from '../../../../modules/api-client/storage.ts'
import * as VpcIds from '../../../../modules/resources/vpc/v1/ids.ts'
import * as IamGrpc from '../../../../modules/api-client/iam.ts'

const PROJECT = process.env.NEBIUS_PROJECT_ID ?? ''
const AI_TEST_TOKEN = 'hosted-e2e-ai-token'
const FIXTURE_MAIN = new URL('../../../fixtures/hosted-instance-program.ts', import.meta.url).href
const INSTANCE_LOGICAL_ID = 'HostedTestInstance'
const FETCH_KEY_NAME = `ak-${`${INSTANCE_LOGICAL_ID}HostedRuntimeKey`.replace(/_/g, '-').toLowerCase().slice(0, 55)}`

/**
 * Optional stable subnet override: Nebius's public-IP path on FRESHLY-created
 * networks is unreachable for 10-40+ min (SYN dropped). Point the test at a
 * PRE-EXISTING subnet (e.g. one left over from a previous run, or a
 * `nebius vpc network create-default`-provisioned network) to bypass the
 * propagation delay: `NEBIUS_TEST_SUBNET_ID=<id>`.
 */
const STABLE_SUBNET_ID = process.env.NEBIUS_TEST_SUBNET_ID

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

/** Poll a URL until it answers 2xx; returns the JSON body. */
const probeJson = async (url: string): Promise<unknown> => {
  // Nebius's SG/network rules can take ~10 min to propagate to a fresh
  // instance's ENI — probe well past the boot window.
  const deadline = Date.now() + 15 * 60 * 1000
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
      // ingress rule so the health probe can reach the hosted port. When
      // NEBIUS_TEST_SUBNET_ID is set, reuse that STABLE subnet (fresh-network
      // public-IP propagation is unreliable — see the note above) and only
      // create the SG + rules on its network.
      const { networkId, subnet, sa, sg, endpoint } = yield* stack.deploy(
        Effect.gen(function* () {
          const fresh = STABLE_SUBNET_ID === undefined
          const networkId = fresh
            ? (yield* Nebius.vpc.Network('HostedTest-Network', {})).id
            : yield* subnetNetworkId(STABLE_SUBNET_ID)
          const subnet = fresh
            ? yield* Nebius.vpc.Subnet('HostedTest-Subnet', { networkId })
            : { id: STABLE_SUBNET_ID }
          const sa = yield* Nebius.iam.ServiceAccount('HostedTest-SA', {
            description: 'hosted runtime test',
          })
          const sg = yield* Nebius.vpc.SecurityGroup('HostedTest-SG', { networkId })
          yield* Nebius.vpc.SecurityRule('HostedTest-SG-Rule', {
            parentId: sg.id,
            direction: 'INGRESS',
            protocol: 'TCP',
            access: 'ALLOW',
            ingress: { sourceCidrs: ['0.0.0.0/0'], destinationPorts: [3000] },
          })
          // Egress: the custom SG replaces the default (which has no egress
          // rules) — the VM needs outbound HTTPS for bun install + the S3 fetch.
          yield* Nebius.vpc.SecurityRule('HostedTest-SG-Egress', {
            parentId: sg.id,
            direction: 'EGRESS',
            protocol: 'ANY',
            access: 'ALLOW',
            egress: { destinationCidrs: ['0.0.0.0/0'] },
          })
          // The AI endpoint the ChatCompletions binding targets. Cheap on purpose:
          // nginx on cpu-d3 (the config `ai/v1/endpoint.integration.test.ts` uses),
          // NOT the GPU vLLM setup — a real chat completion needs a GPU slot, and
          // the runtime client already round-trips against a mocked OpenAI server.
          // What this proves on the VM is the part only a VM can: the injected
          // NEBIUS_ENDPOINT_URL is the MANAGED https URL (AD1's raw `IP:port` bug)
          // and the bearer token is usable from the instance.
          const endpointNetwork = yield* Nebius.vpc.Network('HostedTest-AiNetwork', {})
          const endpointSubnet = yield* Nebius.vpc.Subnet('HostedTest-AiSubnet', {
            networkId: endpointNetwork.id,
          })
          const endpoint = yield* Nebius.ai.Endpoint('HostedTest-AiEndpoint', {
            image: 'nginx:alpine',
            platform: 'cpu-d3',
            preset: '4vcpu-16gb',
            subnetId: endpointSubnet.id,
            publicIp: true,
            preemptible: false,
            environmentVariables: [],
            ports: [{ containerPort: 80, protocol: 'HTTP' }],
            volumes: [],
            disk: { type: 'NETWORK_SSD', sizeBytes: 107_374_182_400 },
            authToken: AI_TEST_TOKEN,
          })
          return { networkId, subnet, sa, sg, endpoint }
        }),
      )
      expect(networkId).toBeDefined()
      expect(subnet.id).toBeDefined()
      expect(sa.id).toBeDefined()
      expect(sg.id).toBeDefined()
      expect(endpoint.publicEndpoints.length).toBeGreaterThan(0)
      const managedEndpointUrl = endpoint.publicEndpoints.find((e: string) => e.startsWith('https://'))
      expect(managedEndpointUrl).toBeDefined()
      console.log(`[E2E] endpoint RUNNING, managed URL: ${managedEndpointUrl}`)

      // Stage 2: re-declare the stack-owned deps + the hosted instance (main = fixture).
      process.env.HOSTED_TEST_SUBNET_ID = subnet.id
      process.env.HOSTED_TEST_SA_ID = sa.id
      const { instance, bucketName, expectedKeyId, expectedSecret } = yield* stack.deploy(
        Effect.gen(function* () {
          if (STABLE_SUBNET_ID === undefined) {
            yield* Nebius.vpc.Network('HostedTest-Network', {})
            yield* Nebius.vpc.Subnet('HostedTest-Subnet', { networkId })
          }
          yield* Nebius.iam.ServiceAccount('HostedTest-SA', {
            description: 'hosted runtime test',
          })
          const sg = yield* Nebius.vpc.SecurityGroup('HostedTest-SG', { networkId })
          yield* Nebius.vpc.SecurityRule('HostedTest-SG-Rule', {
            parentId: sg.id,
            direction: 'INGRESS',
            protocol: 'TCP',
            access: 'ALLOW',
            ingress: { sourceCidrs: ['0.0.0.0/0'], destinationPorts: [3000] },
          })
          // Egress: the custom SG replaces the default (which has no egress
          // rules) — the VM needs outbound HTTPS for bun install + the S3 fetch.
          yield* Nebius.vpc.SecurityRule('HostedTest-SG-Egress', {
            parentId: sg.id,
            direction: 'EGRESS',
            protocol: 'ANY',
            access: 'ALLOW',
            egress: { destinationCidrs: ['0.0.0.0/0'] },
          })
          const bucket = yield* Nebius.storage.Bucket('HostedTest-Bucket', {
            versioningPolicy: 'DISABLED',
            defaultStorageClass: 'STANDARD',
            objectAuditLogging: 'NONE',
            forceStorageClass: false,
          })
          // Re-declared (noop) so the re-plan does not delete the endpoint the
          // binding injects into the instance's env file.
          const endpointNetwork = yield* Nebius.vpc.Network('HostedTest-AiNetwork', {})
          const endpointSubnet = yield* Nebius.vpc.Subnet('HostedTest-AiSubnet', {
            networkId: endpointNetwork.id,
          })
          const endpoint = yield* Nebius.ai.Endpoint('HostedTest-AiEndpoint', {
            image: 'nginx:alpine',
            platform: 'cpu-d3',
            preset: '4vcpu-16gb',
            subnetId: endpointSubnet.id,
            publicIp: true,
            preemptible: false,
            environmentVariables: [],
            ports: [{ containerPort: 80, protocol: 'HTTP' }],
            volumes: [],
            disk: { type: 'NETWORK_SSD', sizeBytes: 107_374_182_400 },
            authToken: AI_TEST_TOKEN,
          })
          const instance = yield* Nebius.compute.Instance(
            INSTANCE_LOGICAL_ID,
            {
              serviceAccountId: sa.id,
              resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
            bootDisk: {
              attachMode: 'READ_WRITE',
              managedDisk: {
                // Per-run name — a fixed name collides with the orphan of a
                // crashed previous run (disk names are unique per project).
                name: runDiskName('boot-disk'),
                // Nebius enforces a 64 GiB boot-disk floor — smaller disks
                // hang provisioning (cloud-init never runs). The image is
                // REQUIRED (blank disk = no OS); the platform resolves the
                // latest image of the family.
                spec: {
                  type: 'NETWORK_SSD',
                  sizeGibibytes: 64,
                  sourceImageFamily: { imageFamily: 'ubuntu24.04-driverless' },
                },
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
          },
          // The binding lives on the DEPLOY side: a bundle is never executed by
          // the CLI, so `main` (the fixture) cannot register it. This init
          // Effect is the only place the instance is its own `Self` host — the
          // real (unmocked) resolution is proven in `hosted-bindings.test.ts`.
          //
          // Passing an impl also clears `isExternal`, which is what makes the
          // provider wrap the bundle in the Nebius bootstrap virtual entry.
          // Without it the VM bundle is the raw fixture and NOTHING runs it
          // (verified: no wrapper → no HTTP listener), so `main`-only
          // declarations can never serve.
          Effect.gen(function* () {
            // GetObject is enough to trigger `hostIdentity` + `grantBucketAccess`
            // + the env registration; PutObject adds the editor grant the
            // fixture's round-trip needs.
            yield* Nebius.storage.GetObject(bucket).pipe(Effect.provide(Nebius.storage.GetObjectHttp))
            yield* Nebius.storage.PutObject(bucket).pipe(Effect.provide(Nebius.storage.PutObjectHttp))
            // The AI binding: no identity/permit — it injects the endpoint's
            // managed URL + bearer token into the same shipped env file.
            yield* Nebius.ai.ChatCompletions(endpoint).pipe(Effect.provide(Nebius.ai.ChatCompletionsHttp))
            // No handler shape on purpose: the VM runs the fixture's own impl
            // (this one only exists to register the bindings at deploy time).
          }),
        )
          // The identity the binding registered: same host logical id → same FQN
          // (the namespace pin) → the SAME resource, so these are the exact
          // values the binding injected into the env file. Captured for a
          // side-by-side comparison with what the VM reports receiving.
          const identity = yield* hostIdentity(INSTANCE_LOGICAL_ID)
          return {
            instance,
            bucketName: bucket.name,
            expectedKeyId: identity.awsAccessKeyId,
            expectedSecret: identity.secretAccessKey,
          }
        }),
      )

      const { instance: _sanity, bucketName: _sanityBucket } = { instance, bucketName }
      void _sanity
      void _sanityBucket
      console.log(
        `[E2E] expected keyId=${String(expectedKeyId).slice(0, 10)}… secretLen=${String(expectedSecret).length}`,
      )
      // CONTROL — the SAME credentials from this CLI process. If these work while
      // the VM's fail, the credential is fine and something about the VM's
      // environment (region/scope/network) is wrong; if they fail too, the
      // credential captured at create time is genuinely bad.
      const laptopOutcome = yield* Effect.promise(async () => {
        const client = new S3Client({
          endPoint: `https://storage.${process.env.NEBIUS_REGION ?? 'eu-north1'}.nebius.cloud`,
          region: process.env.NEBIUS_REGION ?? 'eu-north1',
          accessKey: String(expectedKeyId),
          secretKey: String(expectedSecret),
          bucket: bucketName,
          pathStyle: true,
        })
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await client.putObject('laptop-control.txt', 'control', { metadata: { 'Content-Type': 'text/plain' } })
            const res = await client.getObject('laptop-control.txt')
            const text = await res.text()
            await client.deleteObject('laptop-control.txt')
            return `ok:${text}`
          } catch (error) {
            if (attempt === 3) return `error:${error instanceof Error ? error.message : String(error)}`
            await new Promise((resolve) => setTimeout(resolve, 10_000))
          }
        }
        return 'unreachable'
      })
      console.log(`[E2E] laptop control with the SAME creds: ${laptopOutcome}`)
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
      //
      // `s3` + `roundTrip` are the BINDING proof: the deploy-side init Effect
      // registered a real storage binding on this instance, the reconcile
      // merged its env into the shipped env file, and the VM's program used
      // that identity against real S3 (which also proves `grantBucketAccess`).
      const body = (yield* Effect.promise(() => probeJson(`http://${publicIp}:3000/`))) as {
        ok?: boolean
        echo?: string
        s3?: {
          endpoint?: string | null
          bucket?: string | null
          hasAccessKey?: boolean
          keyIdPrefix?: string | null
          secretShape?: string
          secretSha256?: string | null
          region?: string | null
        }
        ai?: {
          url?: string | null
          hasToken?: boolean
          tokenShape?: string
          probe?: string
          typed?: string
          typedBadToken?: string
        }
        roundTrip?: string
        now?: string
      }
      console.log(`[E2E] vm reports: ${JSON.stringify(body.s3)} roundTrip=${String(body.roundTrip).slice(0, 60)}`)
      if (body.now) {
        const vmNow = Date.parse(body.now)
        console.log(`[E2E] vm clock skew: ${Date.now() - vmNow}ms`)
      }
      expect(body.ok).toBe(true)
      expect(body.echo).toBe('hello-from-env')
      expect(body.s3?.bucket).toBe(bucketName)
      expect(body.s3?.endpoint).toContain('storage.')
      expect(body.s3?.hasAccessKey).toBe(true)
      // The injected credential must be EXACTLY the identity's: same key id, a
      // secret of the right shape, and the SAME secret VALUE (digest comparison —
      // a JSON-serialized Output, i.e. an unresolved value, shows up as a longer
      // `{`-prefixed string; a mixed-up sibling secret shows up as a digest
      // mismatch).
      expect(body.s3?.keyIdPrefix).toBe(String(expectedKeyId).slice(0, 10))
      expect(body.s3?.secretShape).toBe(`${String(expectedSecret).length}ch`)
      expect(body.s3?.secretSha256).toBe(
        createHash('sha256').update(String(expectedSecret)).digest('hex').slice(0, 16),
      )
      // REGRESSION: a config value captured by `Platform` must reach the VM as the
      // value, not as a serialized Redacted envelope. It arrived as
      // `{"_tag":"Redacted","value":"eu-north1"}` — which broke SigV4 signing
      // ("authorization header … not valid") until `quoteEnvValue` unwrapped it.
      expect(body.s3?.region).toBe(process.env.NEBIUS_REGION ?? 'eu-north1')

      // AI binding on the VM: the MANAGED https URL and a usable token (a real
      // call to the endpoint, not just the env values).
      console.log(`[E2E] vm reports AI env: ${JSON.stringify(body.ai)}`)
      expect(body.ai?.url).toBe(managedEndpointUrl)
      expect(body.ai?.hasToken).toBe(true)
      expect(body.ai?.tokenShape).toBe(`${AI_TEST_TOKEN.length}ch`)
      expect(body.ai?.probe).toBe('ok:200')
      // The TYPED binding client, executing ON the VM. nginx is not
      // OpenAI-compatible, so the request reaches the endpoint and 404s — the
      // tagged error path, verified on real hardware instead of only in unit
      // tests. With a wrong bearer token the platform rejects it first (401).
      expect(body.ai?.typed).toBe('error:EndpointNotFound')
      expect(body.ai?.typedBadToken).toBe('error:EndpointUnauthorized')
      expect(body.roundTrip).toBe('ok:hello-from-binding')
    }).pipe(safeDestroy(stack, verifyAssetsCleanup)),
  // Budget: two VMs (the nginx AI endpoint + the hosted instance), the instance's
  // bundle boot and HTTP probe, the endpoint's S3 grants, and the destroy.
  { timeout: 30 * 60 * 1000 },
)
