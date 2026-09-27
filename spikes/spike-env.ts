/**
 * The environment every probe reads — and the one thing a probe must never do is commit a default.
 *
 * Probes ran for weeks against **the maintainer's own tenant** because of a single pattern:
 *
 * ```ts
 * const PROJECT_ID = process.env.NEBIUS_PROJECT_ID ?? '<the real project id>'
 * ```
 *
 * Nothing was wrong with the run — the default *was* the right project for the person running it. The
 * damage is that the fallback makes the choice invisible: a probe run by anybody else, or by the
 * maintainer after a move, silently targets a stranger's project instead of failing. R-18 fixed the nine
 * copies under `tests/`; R-23 found 23 more here, because that acceptance was a **path prefix**
 * (`grep -rn … tests/`) rather than a rule about the value.
 *
 * So the rule, in the form R-18 wanted and R-23's own acceptance names: **no literal tenant id is
 * committed anywhere, and a missing variable fails loudly.** Every probe reads its ids through this
 * module; there is no `??` left to fall through.
 *
 * The values live in `.env` (gitignored). Add what the probe you are running needs:
 *
 * ```
 * NEBIUS_PROJECT_ID=project-…              # required by every probe
 * NEBIUS_SUBNET_ID=vpcsubnet-…             # probes that create an instance or a cluster
 * NEBIUS_SERVICE_ACCOUNT_ID=serviceaccount-…  # probes that attach a service account
 * NEBIUS_SUBNET_ID_OTHER=vpcsubnet-…       # only mk8s-write-probe.ts, which changes subnetId *to* it
 * ```
 *
 * `NEBIUS_TENANT_ID` is required by the tenant-addressed probes (capacity, presets) but is deliberately
 * **not** one of the values above: production code reads that same variable name
 * (`Factory.makeTenantScopedList`, i.e. the fan-out `alchemy unsafe nuke` runs). A stale tenant in a
 * shared `.env` would not fail loudly the way a stale subnet id does — it would enumerate the wrong
 * tenant. Export it for the run that needs it instead.
 *
 * The service account is **`NEBIUS_SERVICE_ACCOUNT_ID`, deliberately not `NEBIUS_SA_ID`**: the latter is
 * Alchemy's own SA-key credential variable (`AuthProvider.ts`, `${SA_ID_ENV}` + `NEBIUS_SA_KEY_ID` +
 * `NEBIUS_SA_PRIVATE_KEY`), and that file's comment records what happens when only *part* of the triple is
 * set — “only `NEBIUS_SA_ID` … hijacked resolution and killed provider loading”. A probe that told you to
 * export `NEBIUS_SA_ID` would therefore break the deploy it was probing.
 *
 * `requireOtherSubnetId` exists because mk8s-write-probe's second subnet is *probe state*, not a default:
 * the probe used to carry its id as a literal, so a reader could not tell which of the two subnets was
 * the pre-existing one and which was created for the run.
 *
 * A probe is expected to `process.exit(1)` — it is a script, not a library, and the alternative (a
 * `RuntimeException` nobody catches) prints a stack trace where one sentence would do.
 */

/** Read a required variable, or exit naming it. `process.exit` is `never`, so callers get `string`. */
const required = (name: string, hint: string): string => {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} is required — no default is committed (R-18/R-23). ${hint}`)
    process.exit(1)
  }
  return value
}

/** The tenant the probe operates in. Required by every probe — there is no sensible default. */
export const requireProjectId = (): string =>
  required('NEBIUS_PROJECT_ID', 'Set it in .env (the value is the local `.env` project id).')

/** A pre-existing subnet to create instances/clusters in — it must already exist, probes do not make one. */
export const requireSubnetId = (): string =>
  required('NEBIUS_SUBNET_ID', 'Set it in .env — a subnet that already exists in NEBIUS_PROJECT_ID.')

/** A pre-existing service account to attach where the API requires one. */
export const requireServiceAccountId = (): string =>
  required(
    'NEBIUS_SERVICE_ACCOUNT_ID',
    'Set it in .env — a service account that already exists in NEBIUS_PROJECT_ID. Not NEBIUS_SA_ID: that is Alchemy\u2019s SA-key credential variable.',
  )

/** The tenant that owns the project — only the probes addressing the tenant rather than a project need it. */
export const requireTenantId = (): string =>
  required(
    'NEBIUS_TENANT_ID',
    'Set it in .env — the tenant is the parent of NEBIUS_PROJECT_ID (`nebius iam project get --id <project-id>`).',
  )

/** mk8s-write-probe's *second* subnet: the one it changes `subnetId` to, not the one it starts in. */
export const requireOtherSubnetId = (): string =>
  required(
    'NEBIUS_SUBNET_ID_OTHER',
    'Set it in .env — a second pre-existing subnet, distinct from NEBIUS_SUBNET_ID.',
  )
