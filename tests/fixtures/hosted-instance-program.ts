/**
 * Hosted-instance integration fixture: the bundled program for
 * `Nebius.compute.v1.Instance` host mode.
 *
 * The virtual entry imports this module's DEFAULT export — which must be the
 * INSTANCE RESOURCE (its `RuntimeContext.exports` is what the bootstrap runs).
 * The instance declared here is the bundle-side program entry; the test
 * declares its own `HostedTestInstance` with `main` pointing at this file.
 *
 * The `main` prop is `import.meta.url` — the module itself. Props read
 * `HOSTED_TEST_SUBNET_ID` / `HOSTED_TEST_SA_ID` with empty fallbacks: at the
 * VM the shipped env file doesn't carry them, but the runtime construction
 * never sends API calls (empty values are harmless there).
 */
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as Nebius from '@fllstck/nebius-alchemy'

export default Nebius.compute.Instance(
  'HostedTestInstance',
  Effect.gen(function* () {
    const subnetId = yield* Effect.orDie(
      Config.string('HOSTED_TEST_SUBNET_ID').pipe(Config.withDefault('')),
    )
    const serviceAccountId = yield* Effect.orDie(
      Config.string('HOSTED_TEST_SA_ID').pipe(Config.withDefault('')),
    )
    return {
      main: import.meta.url,
      serviceAccountId,
      resources: { platform: 'cpu-d3', preset: '4vcpu-16gb' },
      bootDisk: {
        attachMode: 'READ_WRITE',
        managedDisk: {
          name: 'boot-disk',
          // Nebius enforces a 64 GiB boot-disk floor — smaller disks hang
          // provisioning (cloud-init never runs).
          spec: { type: 'NETWORK_SSD', sizeGibibytes: 64 },
        },
      },
      networkInterfaces: [{ subnetId, name: 'eth0', ipAddress: { allocationId: '' } }],
      port: 3000,
      // The shipped env file carries this — the program echoes it back so the
      // integration test can assert the env landed on the VM.
      env: { HOSTED_TEST_ECHO: 'hello-from-env' },
    }
  }),
  Effect.succeed({
    fetch: HttpServerResponse.json({
      ok: true,
      echo: process.env.HOSTED_TEST_ECHO ?? '',
    }),
  }),
)
