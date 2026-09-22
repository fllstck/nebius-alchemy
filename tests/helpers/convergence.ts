/**
 * C1 — the behavioural converge-or-declare sweep.
 *
 * `AGENTS.md` §"Convergence" says every user-facing prop MUST be **planned** (`diff`),
 * **reconciled** (reconcile's drift list), or **declared** (create-only / deliberately not
 * converged). Nothing enforced it, and the failure is silent: a prop in neither place plans
 * an update that writes nothing, so the change is simply lost. That is the shape behind
 * `gpuCluster`, `instance.{recoveryPolicy,hostname}`, `disk.{sourceImageId,sourceImageFamily,
 * sourceSnapshotId,diskEncryption}`, `image.{cpuArchitecture,recommendedPlatforms}`,
 * `static-key.{description,expiresAt}`, `security-rule.description` and `record.relativeName`.
 *
 * This turns the rule into a table per resource:
 *
 *   1. **Completeness** — every prop in the resource's `PropsSchema` must be classified:
 *      either given a `change` patch to probe, or listed in `declared` with a reason. Adding
 *      a prop to a resource therefore fails until someone decides how it converges. (This is
 *      the general form of the six hand-written `Object.keys(…fields).toSorted()` guards.)
 *   2. **Behaviour** — applying the patch must plan something (`diff`) or write something
 *      (mocked `reconcile` issuing create/update). Otherwise the change is lost.
 *   3. **Baseline** — the unpatched props must be a noop. Without this every row would pass
 *      vacuously whenever the mocked live resource does not match the baseline.
 *   4. **Anti-loop** (opt-in, `omits`) — omitting an optional prop must not write either.
 *      That is the direction that made the `record.ttl` / `zone.soaSpec` fixes safe.
 *
 * Why behaviour and not text: two text-based audits ("prop named nowhere in the provider",
 * "prop absent from the generated Spec") were tried and deleted (TASKS.md §"What could not be
 * automated"), and a third attempt of mine produced a false positive on
 * `security-rule.direction`. Providers compare *built* `desired` specs, so only behaviour is
 * a reliable oracle — hence `probe` returning `{ planned, wrote }` rather than grepping.
 *
 * Deliberately **not** a Stryker feature: no mutation tooling is involved, this is plain
 * `bun:test` + the existing provider/mocks helpers, so it runs in CI in seconds. (Mutation
 * testing cannot see this bug class at all: it breaks code that exists, and this class is
 * code that was never written.)
 */
import * as BunTest from 'bun:test'
import type * as Effect from 'effect/Effect'
import type * as Layer from 'effect/Layer'
import type { Provider, ProviderService } from 'alchemy/Provider'
import type { ResourceLike } from 'alchemy/Resource'

import { resolveProvider, runDiff, runReconcile } from './provider.ts'

const { expect, test } = BunTest

/** Props are `unknown`-valued on purpose: the provider's own validator runs on every probe,
 * so a baseline the schema rejects fails that row loudly instead of being silently skipped —
 * and branded id props keep accepting plain test-fixture literals. */
type Props = Record<string, unknown>

/**
 * A change row that also pins the exact plan.
 *
 * Without it a row only asserts that *something* was planned, which does not distinguish
 * `{ action: 'replace' }` (create-first) from `{ action: 'replace', deleteFirst: true }` — and
 * that distinction is the replace-ordering contract (AGENTS.md §Replace ordering). Use
 * {@link planned} where the shape is the contract, most obviously for identity changes.
 */
interface Planned {
  readonly patch: Props
  readonly expect: unknown
}

/** Pin the exact plan a change must produce, e.g. `planned({ name: 'x' }, { action: 'replace' })`. */
export const planned = (patch: Props, expect: unknown): Planned => ({ patch, expect })

const isPlanned = (entry: Props | Planned): entry is Planned => 'patch' in entry && 'expect' in entry

/**
 * There is exactly **one** convergence mechanism: the table in `tests/convergence.test.ts`.
 *
 * Every resource used to be in one of two buckets — a table, or "by construction" (its
 * reconcile compares the whole desired spec, asserted against the module source). The second
 * bucket was retired once all 15 of those resources were tabulated: the pattern check could
 * only prove that *a* whole-spec comparison existed, not that every prop reached `desired` —
 * and tabulating them immediately found a prop that reached neither (`transfer.stopCondition`,
 * dropped by `fromJSON` on create *and* update) plus two more shape bugs. One mechanism now,
 * and `tests/convergence-coverage.test.ts` proves no resource escapes it.
 */

export interface ConvergenceSweepConfig<R extends ResourceLike> {
  /** Resource type string, for test titles: `Nebius.dns.v1.Record`. */
  resource: string
  provider: Provider<R>
  // oxlint-disable-next-line no-explicit-any — approved: exported provider layers capture `any` requirements (see resolveProvider)
  providerLayer: Layer.Layer<Provider<R>, never, any>
  /** The props schema — the completeness source of truth. */
  propsSchema: { readonly fields: Record<string, unknown> }
  /** A valid baseline. The provider validates it on every probe. */
  props: Props
  // NOTE for table authors: put an **explicit** `parentId` in the baseline if the resource
  // takes one. `identityChangeRequiresReplace` deliberately ignores a parent that is only set
  // on one side (`undefined → set` usually means "now written down", because props fall back
  // to NEBIUS_PROJECT_ID at reconcile time), so a baseline without one probes the documented
  // exception instead of a real move — and reports a false "silently lost".
  /**
   * The prop being classified → the patch used to probe it.
   *
   * The key must be the prop's name so the completeness check can see it, but the patch is
   * what is applied: some props are only meaningful together (a `security-rule` needs the
   * match block that its `direction` selects, so probing `egress` means swapping the block,
   * not just setting one field). Wrap it in {@link planned} when the exact plan shape is part
   * of the contract.
   */
  change: Record<string, Props | Planned>
  /**
   * Props that legitimately do not converge *by value*, with the reason. This is the
   * "declared" category from AGENTS.md — without it the sweep produces false failures
   * (`labels` is create-time only; `security-rule.direction` is derived from the match block
   * and echoed back through `status`).
   */
  declared?: Record<string, string>
  /** Props whose *omission* must not write: the anti-loop guard. Must also be classified. */
  omits?: ReadonlyArray<string>
  /** What the mocked `get` returns — build it from the baseline, or the rows pass vacuously. */
  live?: unknown
  /** The persisted state id passed to reconcile. */
  liveId?: string
  /**
   * Mock layer for one reconcile run; `writes` receives every create/update request.
   * Required unless `probe` is given.
   */
  // oxlint-disable-next-line no-explicit-any — approved: mirrors the lifecycle helpers
  layerFor?: (writes: Array<unknown>) => (effect: Effect.Effect<any, any, any>) => Effect.Effect<any, any, any>
  /**
   * Escape hatch for a resource whose reconcile needs an environment we do not mock, or
   * whose drift list is a pure exported function (`instanceSpecDrifted`). Returns `true`
   * when the change is not silently lost.
   */
  probe?: (svc: ProviderService<R>, news: Props, baseline: Props) => Promise<boolean>
}

export const convergenceSweep = <R extends ResourceLike>(config: ConvergenceSweepConfig<R>): void => {
  const { resource } = config
  const declared = config.declared ?? {}
  const omits = config.omits ?? []
  const classified = [
    ...new Set([...Object.keys(config.change), ...Object.keys(declared)]),
  ].toSorted()
  const schemaProps = Object.keys(config.propsSchema.fields).toSorted()

  /** `true` when a change is not silently lost: planned by `diff`, or written by `reconcile`. */
  const converges = async (news: Props, baseline: Props): Promise<boolean> => {
    const svc = await resolveProvider(config.provider, config.providerLayer)
    if (config.probe) return config.probe(svc, news, baseline)
    if ((await runDiff(svc, news, baseline)) !== undefined) return true
    if (config.layerFor === undefined || config.liveId === undefined) {
      throw new Error(`${resource}: this sweep needs either \`probe\`, or \`layerFor\` and \`liveId\``)
    }
    const writes: Array<unknown> = []
    await runReconcile(svc, news, { id: config.liveId }, baseline, config.layerFor(writes))
    return writes.length > 0
  }

  const patched = (patch: Props): Props => ({ ...config.props, ...patch })

  /** Probe one set of props, turning "the patch is not valid props" into a table-author error. */
  const probe = async (label: string, news: Props): Promise<boolean> => {
    try {
      return await converges(news, config.props)
    } catch (error) {
      const firstLine = String((error as { message?: string }).message ?? error).split('\n')[0]
      throw new Error(
        `${label}: the table's patch is not valid props for this resource — fix the table entry, not the provider.\n  ${firstLine}`,
        { cause: error },
      )
    }
  }

  test(`${resource}: every prop is planned, reconciled, or declared`, () => {
    expect(
      classified,
      `${resource}: the convergence table does not match the props schema.\n` +
        `  missing (add a \`change\` patch, or declare it with a reason): ${
          schemaProps.filter((p) => !classified.includes(p)).join(', ') || '—'
        }\n` +
        `  stale (no such prop any more — remove the entry): ${
          classified.filter((p) => !schemaProps.includes(p)).join(', ') || '—'
        }`,
    ).toEqual(schemaProps)

    for (const [prop, reason] of Object.entries(declared)) {
      expect(reason, `${resource}.${prop}: a declared prop must say why it does not converge`).not.toBe('')
    }
    for (const prop of omits) {
      expect(classified, `${resource}: \`${prop}\` is in \`omits\` but is not classified`).toContain(prop)
    }
  })

  test(`${resource}: the baseline itself is a noop`, async () => {
    // Guards the sweep against vacuity: if the mocked live resource already differs from the
    // baseline, every row below "converges" for the wrong reason and proves nothing.
    expect(
      await probe(`${resource} (baseline)`, config.props),
      `${resource}: the mocked live resource already differs from the baseline — every row below is vacuous`,
    ).toBe(false)
  })

  test(`${resource}: the baseline plans no change against structurally identical props`, async () => {
    // A RE-APPLY of an unchanged config is the most common `alchemy deploy` there is, and the
    // planner hands `diff` a fresh `news` object plus the persisted `olds` — structurally equal,
    // but never the same reference. A provider that compares an OBJECT-valued prop by reference
    // (`news.source !== olds.source`) therefore plans a replace on every deploy, and because the
    // old generation still holds the identity (`Factory.replaceKeepingName` → create-first) the
    // replacement dies with ALREADY_EXISTS. `storage/v1/transfer` did exactly that (found live
    // 2026-09-22); the reconcile-only baseline row above cannot see it, because it never diffs.
    const svc = await resolveProvider(config.provider, config.providerLayer)
    // Plain-data clone: what the state store hands back, not the config object.
    const olds: unknown = JSON.parse(JSON.stringify(config.props))
    expect(
      await runDiff(svc, config.props, olds),
      `${resource}: an unchanged config plans a change. Compare object-valued props structurally (specDeepEqual), never by reference.`,
    ).toBeUndefined()
  })

  for (const [prop, entry] of Object.entries(config.change)) {
    test(`${resource}: a \`${prop}\` change is planned or written`, async () => {
      const patch = isPlanned(entry) ? entry.patch : entry
      if (isPlanned(entry)) {
        // Shape-pinned row: the plan *is* the contract, so a write does not count as success.
        const svc = await resolveProvider(config.provider, config.providerLayer)
        let plan: unknown
        try {
          plan = await runDiff(svc, patched(patch), config.props)
        } catch (error) {
          const firstLine = String((error as { message?: string }).message ?? error).split('\n')[0]
          throw new Error(
            `${resource}.${prop}: the table's patch is not valid props for this resource — fix the table entry, not the provider.\n  ${firstLine}`,
            { cause: error },
          )
        }
        expect(
          plan,
          `${resource}.${prop}: the plan changed shape. Check the replace ordering (AGENTS.md §Replace ordering):\n` +
            `  create-first is \`{ action: 'replace' }\`, delete-first adds \`deleteFirst: true\`.`,
        ).toEqual(entry.expect)
        return
      }
      expect(
        await probe(`${resource}.${prop}`, patched(patch)),
        `${resource}.${prop}: the change planned nothing and reconcile wrote nothing, so it is silently lost.\n` +
          `  Fix one of: compare it in \`diff\`, compare it in reconcile's drift list, plan a replace, or add it to \`declared\` with a reason.`,
      ).toBe(true)
    })
  }

  for (const prop of omits) {
    test(`${resource}: omitting \`${prop}\` writes nothing`, async () => {
      expect(
        await probe(`${resource}.${prop} (omitted)`, patched({ [prop]: undefined })),
        `${resource}.${prop}: an omitted optional prop must not drive an update — that is an update loop`,
      ).toBe(false)
    })
  }
}
