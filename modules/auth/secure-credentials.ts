/**
 * Secure writes to the Alchemy credential store.
 *
 * Alchemy's {@link Credentials.CredentialsStore} writes with the default
 * umask (0644) — readable by any local user or process. `~/.ssh` and
 * `~/.aws/credentials` use 0600; this helper restores that guarantee for
 * Nebius secrets (SA private keys, OAuth tokens, API keys) stored under
 * `~/.alchemy/credentials/{profile}/{provider}.json`.
 *
 * Fail-hard: if the post-write `chmod 0600` fails, the just-written file is
 * removed (best-effort) so no secret is left world-readable, and the error
 * is surfaced.
 *
 * Generic helper, not `Effect.fn`: `Effect.fn`'s traced signature can't
 * express the `A` credential type param, so this follows the `unrequiring`
 * precedent for generic helpers.
 *
 * Since alchemy v2 beta.77 the store round-trips every credential document
 * through a `Schema.Codec`, so callers pass the schema alongside the value —
 * this is what makes a hand-edited or stale credentials file fail with a
 * reconfigure hint instead of reaching provider code unchecked.
 */
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import type { PlatformError } from 'effect/PlatformError'
import * as Schema from 'effect/Schema'
import type { AuthError } from 'alchemy/Auth/AuthProvider'
import * as Credentials from 'alchemy/Auth/Credentials'

export const writeSecureCredentials = <A, E>(
  store: Credentials.CredentialsStoreService,
  profile: string,
  provider: string,
  schema: Schema.Codec<A, E>,
  credentials: A,
): Effect.Effect<void, AuthError | PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const filePath = Credentials.credentialsFilePath(profile, provider)
    yield* store.write(profile, provider, schema, credentials)
    yield* fs.chmod(filePath, 0o600).pipe(
      Effect.catch((cause) =>
        fs.remove(filePath).pipe(
          Effect.andThen(Effect.fail(cause)),
          // Cleanup is best-effort: if removal fails too, still surface the
          // original chmod error.
          Effect.catch(() => Effect.fail(cause)),
        ),
      ),
    )
  })
