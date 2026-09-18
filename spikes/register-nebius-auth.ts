/**
 * Auth-registration entrypoint — for bootstrapping Nebius credentials on a
 * machine that has none yet.
 *
 * Why this exists: `bun alchemy profile edit --add Nebius` loads an entrypoint
 * and builds its `providers` layer purely to collect auth providers (see
 * `collectAuthProvidersUncached` in alchemy's `Alchemist/Session.ts`). Upstream
 * documents `AuthProviderLayer` as existing so the CLI can "discover the
 * provider via the registry **without forcing credential resolution**" — but
 * our full `providers()` chain resolves credentials while it builds (it ends in
 * `Layer.orDie`, so the failure arrives as an unsuppressable die rather than the
 * typed `MissingProviderConfig` the collector knows to swallow).
 *
 * Net effect: on a fresh machine the documented first-run flow fails with
 * "Could not load auth providers", and the README's promise of "browser login,
 * no API key, no environment variables" does not hold. Providing ONLY the auth
 * layer here sidesteps that, so the OAuth login can store a profile; once a
 * profile exists the real `providers()` builds normally.
 *
 * Usage:
 *   bun alchemy profile edit --add Nebius -c spikes/register-nebius-auth.ts
 *   # → choose "Nebius account (OAuth)"
 *
 * Tracked in TASKS.md as the first-run bootstrap gap; delete this file once
 * the provider graph can be built without credentials.
 */
import * as Alchemy from 'alchemy'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import * as AuthProvider from '../modules/AuthProvider.ts'
import * as SaBootstrap from '../modules/auth/sa-bootstrap.ts'
import * as SaToken from '../modules/auth/sa-token.ts'

export default Alchemy.Stack(
  'NebiusAuthRegister',
  {
    providers: Layer.empty.pipe(
      Layer.provideMerge(AuthProvider.NebiusAuth),
      Layer.provideMerge(SaToken.SaTokenMinterLive),
      Layer.provideMerge(SaBootstrap.SaBootstrapLive),
    ),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    return {}
  }),
)
