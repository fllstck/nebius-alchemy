/**
 * Shared Alchemy Test API + Nebius namespace for integration tests.
 *
 * Every integration file used to construct its own provider graph at module
 * scope:
 *
 *   const { test } = Test.make({ providers: Nebius.providers() as any })
 *
 * That imports the FULL `@fllstck/nebius-alchemy` package (~200ms measured)
 * in every test process — including plain `bun test` runs where every
 * integration test is skipped at collection time and the providers are never
 * consumed. The package import, not `providers()` / `Test.make` (each
 * ~0.1ms), dominates collection time for the 32 integration files.
 *
 * This module builds the Test API once per process and defers the package
 * import:
 *
 * - Unit-only runs (`bun test`, no `SLOW_TESTS`): the `Nebius` namespace is
 *   an empty stub and `Test.make` receives empty providers. Safe because every
 *   provider test is gated behind `integrationTest(...)` /
 *   `test.provider.skipIf(...)`, which skips at collection time — the
 *   providers are never consumed.
 * - Integration runs (`SLOW_TESTS=1 bun test`): the real namespace is loaded
 *   and passed to `Test.make`, byte-for-byte the old per-file behavior.
 *
 * Each bun test file runs in its own process, so this module-level singleton
 * is per-file in practice — identical semantics to constructing in each file,
 * with the construction centralized in one place.
 */
import * as Test from 'alchemy/Test/Bun'

import { runIntegration } from './gate'

// The full module type so test bodies type-check against the real namespace.
// oxlint-disable-next-line no-explicit-any — the type is only used for the
// stub cast below; see the header comment for why the stub is safe.
type NebiusModule = typeof import('@fllstck/nebius-alchemy')

/**
 * The Nebius namespace. The real module when integration tests will run; an
 * empty stub otherwise (bodies that reference it are skipped at collection
 * time, so the stub is never touched in unit-only runs).
 */
export const Nebius: NebiusModule = (runIntegration()
  ? await import('@fllstck/nebius-alchemy')
  : {}) as NebiusModule

/**
 * The shared Test API. `providers` is consumed only when a provider test
 * actually runs — impossible in unit-only runs (all integration tests are
 * skipped), so the empty stub in that mode is never observed.
 */
export const { test } = Test.make({
  // The historical per-file `as any` cast; Test.make options are untyped.
  // oxlint-disable-next-line no-explicit-any — approved exception
  providers: (Nebius.providers?.() ?? {}) as any,
})
