/**
 * Resolve the Nebius **tenant** ID that tenant-scoped operations need.
 *
 * ## Why a helper instead of a bare `Config.String`
 *
 * Several operations address the *tenant* rather than the project: enumerating
 * projects to fan a `list` out across them (see `factory.ts`'s
 * `makeTenantScopedList`), tenant-parented resources (federation, invitation,
 * group-membership, federation-certificate), and the discovery
 * `Nebius.*.action.*` resources.
 *
 * A plain `yield* Config.String("NEBIUS_TENANT_ID")` fails with
 * `ConfigError: SchemaError(Expected string at ["NEBIUS_TENANT_ID"])` — accurate
 * but unactionable: it names the variable without saying where to find the
 * value or why it is suddenly required.
 *
 * ## When this can actually bite
 *
 * It is only needed where something genuinely *lists across projects*:
 *
 * - `alchemy unsafe nuke` — the only place alchemy calls a provider's `list`
 * - the discovery `action` resources, if a stack declares one
 *
 * A normal `deploy` / `plan` / `destroy` / `dev` never reads it (verified by
 * running a bucket lifecycle with `NEBIUS_TENANT_ID` unset).
 *
 * The value is normally supplied for you: `NebiusProjectConfigProviderLive`
 * layers it in from the stored profile. It is *absent* only when
 *
 * - auth is `env` (`NEBIUS_API_KEY` / `NEBIUS_SA_*`) and the variable was not
 *   set, or
 * - the profile is `sa-key` bootstrapped before the tenant was recorded.
 *
 * `env` users must set it; `sa-key` profiles now record it at bootstrap.
 */
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

/**
 * A tenant-scoped operation ran without a usable tenant ID.
 *
 * Tagged (not a raw `ConfigError`) so callers can `Effect.catchTag` it, and so
 * the failure carries guidance rather than just a missing-path pointer.
 */
export class MissingTenantIdError extends Schema.TaggedError<MissingTenantIdError>()(
  'MissingTenantIdError',
  { message: Schema.String },
) {}

const guidance = (envVar: string): string =>
  [
    `Nebius tenant ID is required for this operation but ${envVar} is not set.`,
    '',
    'Where to find it: the tenant is the *parent* of your project —',
    '  nebius iam project get --id <project-id>   # read metadata.parent_id',
    '',
    'How to supply it:',
    `  - export ${envVar}=<tenant-id>   (required for env/CI auth)`,
    '  - or use a profile, which records it: `alchemy profile edit --add Nebius`',
    '',
    'Note: a normal deploy/plan/destroy does not need it — it is required only by',
    'operations that enumerate across projects, such as `alchemy unsafe nuke`.',
  ].join('\n')

/**
 * Read the tenant ID, failing with an actionable error when absent.
 *
 * `envVar` is parameterised for `factory.ts`, whose resources may declare an
 * alternative variable name via `tenantEnvVar`.
 */
export const resolveTenantId = Effect.fn('Nebius.resolveTenantId')(function* (envVar = 'NEBIUS_TENANT_ID') {
  const value = yield* Config.option(Config.String(envVar))
  if (Option.isSome(value) && value.value !== '') return value.value
  return yield* new MissingTenantIdError({ message: guidance(envVar) })
})
