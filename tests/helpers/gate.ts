/**
 * Integration test gating — single source of truth for the `SLOW_TESTS` flag.
 *
 * A plain `bun test` (no env vars) must NEVER touch the network or mutate real
 * infrastructure. Every test that deploys/destroys real Nebius resources or
 * opens a real gRPC channel is gated behind `SLOW_TESTS=1`:
 *
 *   bun test                       # unit tests only — network-free
 *   SLOW_TESTS=1 bun test tests/   # everything, including integration
 *
 * Usage with Alchemy's Test.make (resource lifecycle tests):
 *
 *   const { test } = Test.make({ providers: Nebius.providers() as any })
 *   integrationTest(test.provider, 'Nebius.storage.v1.Bucket lifecycle', (stack) =>
 *     Effect.gen(function* () { ... }),
 *     { timeout: 120_000 },
 *   )
 *
 * Usage with plain bun tests that additionally need real credentials
 * (api-client files):
 *
 *   const it = runIntegration() && hasCredentials ? test : test.skip
 */
import type * as TestBun from 'alchemy/Test/Bun'

export const runIntegration = (): boolean => Boolean(process.env.SLOW_TESTS)

export const integrationTest = (
  provider: TestBun.TestApi['test']['provider'],
  name: string,
  fn: Parameters<TestBun.TestApi['test']['provider']>[1],
  opts?: Parameters<TestBun.TestApi['test']['provider']>[2],
): void => {
  provider.skipIf(!runIntegration())(name, fn, opts)
}
