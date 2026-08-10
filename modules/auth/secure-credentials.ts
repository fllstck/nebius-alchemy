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
 * express the `T` credential type param, so this follows the `unrequiring`
 * precedent for generic helpers.
 */
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import type { PlatformError } from 'effect/PlatformError'
import * as Credentials from 'alchemy/Auth/Credentials'

export const writeSecureCredentials = <T>(
  store: Credentials.CredentialsStoreService,
  profile: string,
  provider: string,
  credentials: T,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const filePath = Credentials.credentialsFilePath(profile, provider)
    yield* store.write(profile, provider, credentials)
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
