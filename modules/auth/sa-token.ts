/**
 * Non-interactive Nebius IAM token minting via the RFC 8693 token exchange.
 *
 * Deploy-time only (never ships in Worker bundles — reachable only through
 * the `__ALCHEMY_RUNTIME__`-guarded provider graph). This is the same path
 * the Nebius Terraform provider and `piotrjanik/nebius-actions` use:
 *
 *   1. Build a short-lived (5-min) self-signed RS256 JWT from a service
 *      account's authorized key (`kid` = key ID, `iss`/`sub` = SA ID).
 *   2. Exchange it at `tokens.iam.api.nebius.cloud:443` for a 12-hour IAM
 *      access token via `TokenExchangeService.Exchange`.
 *
 * Unlike `nebius iam get-access-token` (which drops into an interactive
 * browser-OAuth flow and blocks when the CLI's token is expired), this path
 * is fully headless — safe for CI and for the alchemy deploy process.
 *
 * ⚠️ The token endpoint is unauthenticated BY DESIGN (the JWT *is* the
 * credential). It must NOT go through `NebiusGrpcTransport`, which attaches
 * the API key as a Bearer header (GrpcTransport.ts) — chicken-and-egg here.
 * The client below uses a bare TLS channel with no auth metadata.
 */
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { createSign } from 'node:crypto'
import * as grpc from '@grpc/grpc-js'
import { TokenExchangeServiceClient } from '../../schemas/nebius/iam/v1/token_exchange_service.ts'
import { ExchangeTokenRequest } from '../../schemas/nebius/iam/v1/token_service.ts'

export const TOKEN_EXCHANGE_ENDPOINT = 'tokens.iam.api.nebius.cloud:443'
export const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange'
export const SUBJECT_TOKEN_TYPE_JWT = 'urn:ietf:params:oauth:token-type:jwt'
/** JWT lifetime: 5 minutes (matches the docs' `--exp +5 minutes` guidance). */
export const JWT_TTL_SECONDS = 300
/** Per-call deadline so a dead endpoint can never hang the deploy. */
export const EXCHANGE_DEADLINE_MS = 30_000

/** Service-account authorized-key credentials (the private key is user-held). */
export interface SaKey {
  readonly serviceAccountId: string
  readonly keyId: string
  readonly privateKey: string
}

/** Raised when the token exchange fails (bad key, unknown SA, network, …). */
export class SaTokenError extends Schema.TaggedErrorClass<SaTokenError>()('SaTokenError', {
  message: Schema.String,
}) {}

const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')

/**
 * Sign a self-signed RS256 JWT for the token exchange.
 *
 * Pure and deterministic given `nowMs`, so it's unit-testable without any
 * network or keys beyond an RSA private key.
 */
export const signJwt = (key: SaKey, nowMs = Date.now()): string => {
  const now = Math.floor(nowMs / 1000)
  const header = { alg: 'RS256', typ: 'JWT', kid: key.keyId }
  const payload = { iss: key.serviceAccountId, sub: key.serviceAccountId, iat: now, exp: now + JWT_TTL_SECONDS }
  const signingInput = `${b64url(header)}.${b64url(payload)}`
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key.privateKey)
  return `${signingInput}.${signature.toString('base64url')}`
}

/** Build the RFC 8693 exchange request for a signed JWT. */
export const buildExchangeRequest = (jwt: string): ExchangeTokenRequest =>
  ExchangeTokenRequest.fromPartial({
    grantType: TOKEN_EXCHANGE_GRANT_TYPE,
    subjectToken: jwt,
    subjectTokenType: SUBJECT_TOKEN_TYPE_JWT,
  })

/**
 * Exchange a JWT for a 12-hour IAM access token.
 *
 * Creates a short-lived gRPC client on a bare TLS channel (no auth metadata —
 * see the module doc) and closes it after the call. Bounded by
 * {@link EXCHANGE_DEADLINE_MS} so a dead endpoint fails fast.
 */
export const exchangeToken = (jwt: string): Effect.Effect<string, SaTokenError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const client = new TokenExchangeServiceClient(TOKEN_EXCHANGE_ENDPOINT, grpc.credentials.createSsl())
        client.exchange(
          buildExchangeRequest(jwt),
          new grpc.Metadata(),
          { deadline: new Date(Date.now() + EXCHANGE_DEADLINE_MS) },
          (error, response) => {
            client.close()
            if (error) reject(error)
            else resolve(response.accessToken)
          },
        )
      }),
    // Options form: `catch` receives the raw rejection (the function form
    // would wrap it in an UnknownError, hiding the gRPC message).
    catch: (cause) =>
      new SaTokenError({
        message: `Nebius token exchange failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })

/**
 * Service that mints a 12-hour IAM token from SA-key credentials.
 *
 * A Context service (not a direct import) so the resolution flow is testable
 * with a fake in `tests/AuthProvider.test.ts` without a gRPC server.
 */
export class SaTokenMinter extends Context.Service<
  SaTokenMinter,
  { readonly mint: (key: SaKey) => Effect.Effect<string, SaTokenError> }
>()('SaTokenMinter') {}

export const SaTokenMinterLive = Layer.succeed(SaTokenMinter, {
  mint: (key: SaKey): Effect.Effect<string, SaTokenError> => exchangeToken(signJwt(key)),
})
