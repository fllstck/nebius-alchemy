import { test, expect } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Path from 'effect/Path'
import { NodeFileSystem } from '@effect/platform-node'
import * as Hosted from '../../../../modules/resources/compute/v1/hosted.ts'
import * as InstanceSchema from '../../../../modules/resources/compute/v1/instance.schema.ts'

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
  const proc = Bun.spawn(['bun', entryPath], { env: process.env })
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
    expect(JSON.parse(body || '{}')).toEqual({ ok: true, echo: 'hello-from-env' })
  } finally {
    proc.kill()
  }
})
