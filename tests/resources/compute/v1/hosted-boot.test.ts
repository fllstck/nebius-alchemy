import { test, expect } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Path from 'effect/Path'
import { NodeFileSystem } from '@effect/platform-node'
import * as Hosted from '../../../../modules/resources/compute/v1/hosted.ts'
import * as InstanceSchema from '../../../../modules/resources/compute/v1/instance.schema.ts'

// Slow by nature: bundling the fixture through rolldown AND booting a real
// `bun` process, then polling until it serves. ~2.7s locally, but >5s on a
// GitHub runner, where bun's 5s default killed it at 5054ms. The readiness loop
// below already allows 30s for the boot, so the harness bound must exceed that
// or the loop's deadline is unreachable (with a 5s harness timeout it was dead
// code). Same reasoning as INTEGRATION_TIMEOUT_MS in tests/helpers/gate.ts.
test('bundle + locally boot the hosted fixture', async () => {
  const props = {
    serviceAccountId: 'sa-x',
    resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
    bootDisk: { attachMode: 'READ_WRITE', managedDisk: { name: 'boot-disk', spec: { type: 'NETWORK_SSD', sizeGibibytes: 10 } } },
    networkInterfaces: [{ subnetId: 'subnet-x', name: 'eth0' }],
    main: new URL('../../../fixtures/hosted-instance-program.ts', import.meta.url).href,
    port: 3000,
  } as InstanceSchema.InstanceProps

  const { files } = await Effect.runPromise(
    Hosted.bundleProgram('HostedTestInstance', props).pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(Path.layer),
    ),
  )
  const entry = files[0]!
  const entryPath = '/tmp/hosted-boot-entry.mjs'
  await Bun.write(entryPath, entry.content)
  for (const chunk of files.slice(1)) {
    await Bun.write(`/tmp/${chunk.path}`, chunk.content)
  }
  process.env.PORT = '3210'
  process.env.ALCHEMY_STACK_NAME = 'Compute'
  process.env.ALCHEMY_STAGE = 'dev'
  process.env.ALCHEMY_PHASE = 'runtime'
  process.env.HOSTED_TEST_ECHO = 'hello-from-env'
  // The S3 env comes from the binding at deploy time; a developer shell that
  // happens to export NEBIUS_* would change the response shape, so the boot
  // process gets an explicitly S3-free env.
  const bootEnv = { ...process.env }
  for (const name of [
    'NEBIUS_S3_ENDPOINT',
    'NEBIUS_REGION',
    'NEBIUS_ACCESS_KEY_ID',
    'NEBIUS_SECRET_ACCESS_KEY',
    'NEBIUS_BUCKET_NAME',
  ]) {
    delete bootEnv[name]
  }
  const proc = Bun.spawn(['bun', entryPath], { env: bootEnv })
  try {
    const deadline = Date.now() + 30_000
    let body = ''
    while (Date.now() < deadline) {
      try {
        const res = await fetch('http://localhost:3210/')
        if (res.ok) { body = await res.text(); break }
      } catch { /* not up yet */ }
      await Bun.sleep(500)
    }
    console.log('PROBE BODY:', body)
    // No binding env on a local boot: the S3 half reports absent and the
    // round-trip is skipped. (On the VM the binding supplies these and the
    // round-trip runs — see hosted-instance.integration.test.ts.) The `s3`
    // report is what pins the binding → shipped-env-file seam in this
    // cloud-free test.
    expect(JSON.parse(body || '{}')).toEqual({
      ok: true,
      echo: 'hello-from-env',
      s3: {
        endpoint: null,
        bucket: null,
        hasAccessKey: false,
        keyIdPrefix: null,
        region: null,
        secretShape: 'absent',
        secretSha256: null,
      },
      // No AI binding on a local boot either — proves the env comes from the
      // binding, not from the framework.
      ai: { url: null, hasToken: false, tokenShape: 'absent', probe: 'skipped' },
      roundTrip: 'skipped',
      // Request-time VM clock (skew diagnostic) — dynamic by nature.
      now: expect.any(String),
    })
  } finally {
    proc.kill()
  }
}, { timeout: 60_000 })
