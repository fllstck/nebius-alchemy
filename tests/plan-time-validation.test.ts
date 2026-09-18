/**
 * Policy guard — **every** resource provider must validate props at BOTH
 * plan-time entry points.
 *
 * This exists because the policy is otherwise pure convention: nothing stops a
 * new resource from being added with no props validation, which is exactly the
 * state this repo was in before 2026-08-10 (see TASKS.md Task 7). The guard is
 * deliberately generic and self-discovering, so a newly added resource is
 * covered automatically rather than silently skipped.
 *
 * Why two entry points (the non-obvious part):
 *   - `diff()` runs at plan time for resources that ALREADY have persisted
 *     state — updates.
 *   - `read()` runs at plan time for GREENFIELD resources. `Plan.ts` returns
 *     early on `if (!oldState || oldState.status === "creating")` *before*
 *     reaching `provider.diff`, so for a brand-new resource `read` (invoked as
 *     the adoption probe) is the ONLY provider hook the planner calls.
 * Validating in `diff` alone leaves first deploys unchecked — the bug Task 7
 * was written for.
 */
import { Glob } from 'bun'
import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import type * as Layer from 'effect/Layer'
import type { Provider, ProviderService } from 'alchemy/Provider'
import type { ResourceLike } from 'alchemy/Resource'
import { diffInput, readInput, resolveProvider, runEffect } from './helpers/provider.ts'

const { describe, expect, test } = BunTest

/**
 * A resolved value that no props schema can decode: every Nebius props schema
 * is a `Schema.Struct`, so a string fails all of them.
 *
 * Deliberately generic — this asserts the validator is *wired up*, not that it
 * is the right one. Per-resource suites cover validator correctness; the point
 * here is that a missing wire cannot slip through.
 */
const NOT_PROPS = 'not-props'

const PROVIDER_EXPORT = /^Nebius\w+Provider$/

const REPO_ROOT = new URL('..', import.meta.url).pathname

const files = (
  await Array.fromAsync(new Glob('modules/resources/**/*.ts').scan(REPO_ROOT))
)
  .filter(
    (f) =>
      !f.endsWith('.schema.ts') &&
      // Barrels re-export providers under short names (`BucketProvider`), which
      // would double-count against the canonical `NebiusBucketProvider`.
      !f.endsWith('/index.ts') &&
      !f.includes('/shared/') &&
      !f.endsWith('.d.ts'),
  )
  .sort()

// oxlint-disable-next-line no-explicit-any
const discovered: Array<{ name: string; file: string; provider: any; resource: any }> = []

for (const file of files) {
  // oxlint-disable-next-line no-explicit-any
  let mod: Record<string, any>
  try {
    mod = await import(`../${file}`)
  } catch {
    continue // not a resource provider module (e.g. a helper)
  }
  for (const [key, value] of Object.entries(mod)) {
    if (!PROVIDER_EXPORT.test(key)) continue
    const resource = mod[key.slice(0, -'Provider'.length)]
    if (!resource?.Provider) continue
    discovered.push({ name: key, file, provider: value, resource })
  }
}

/**
 * The number of resource providers in `modules/Provider.ts`'s `providers()`.
 *
 * Kept as a literal so that adding or removing a resource forces a conscious
 * update here — a discovery bug (renamed export, moved file) would otherwise
 * shrink the sweep silently and the policy would stop being enforced.
 */
const EXPECTED_PROVIDER_COUNT = 38

type Lifecycle = 'read' | 'diff'

/**
 * Sweep every provider through one lifecycle with invalid props and return a
 * human-readable report of every provider that did NOT reject them.
 */
const sweep = async (lifecycle: Lifecycle): Promise<string[]> => {
  const notRejecting: string[] = []

  for (const { name, resource, provider } of discovered) {
    let svc: ProviderService<ResourceLike>
    try {
      svc = await resolveProvider(
        resource.Provider as Provider<ResourceLike>,
        provider as Layer.Layer<Provider<ResourceLike>, never, unknown>,
      )
    } catch (err) {
      notRejecting.push(`${name}: could not resolve provider — ${(err as Error).message}`)
      continue
    }

    const fn = svc[lifecycle]
    if (typeof fn !== 'function') {
      notRejecting.push(`${name}: has no \`${lifecycle}\` lifecycle`)
      continue
    }

    // oxlint-disable-next-line no-explicit-any
    const input = lifecycle === 'diff' ? diffInput(NOT_PROPS) : readInput(NOT_PROPS)
    try {
      // oxlint-disable-next-line no-explicit-any
      const error = await runEffect((fn as (i: any) => Effect.Effect<any, any, any>).call(svc, input).pipe(Effect.flip))
      if (error?._tag !== 'PropsValidationError') {
        notRejecting.push(`${name}: resolved instead of rejecting (got ${JSON.stringify(error)})`)
      }
    } catch (err) {
      notRejecting.push(`${name}: did not reject — ${(err as Error).message}`)
    }
  }

  return notRejecting
}

describe('plan-time props validation policy', () => {
  test('discovers every resource provider', () => {
    // A shortfall means discovery broke OR a resource was added without being
    // wired; a surplus means the module list gained something unexpected.
    expect(
      discovered.length,
      `discovered ${discovered.length} providers:\n${discovered.map((d) => `  ${d.name} (${d.file})`).join('\n')}`,
    ).toBe(EXPECTED_PROVIDER_COUNT)
  })

  test('every provider rejects invalid props on the diff path (updates)', async () => {
    // `diff` is what `alchemy plan` calls for a resource that already exists.
    expect(await sweep('diff')).toEqual([])
  })

  test('every provider rejects invalid props on the read path (greenfield)', async () => {
    // `read` is the ONLY plan-time hook for a resource with no persisted state,
    // because Plan.ts short-circuits before `diff`. This is the regression
    // guard for the 2026-08-12 blank-boot-disk class of bug.
    expect(await sweep('read')).toEqual([])
  })
})
