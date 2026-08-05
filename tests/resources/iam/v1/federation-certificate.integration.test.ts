import * as Test from 'alchemy/Test/Bun'
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import * as Nebius from '@fllstck/nebius-alchemy'

const { test } = Test.make({ providers: Nebius.providers() as any })

test.provider.skipIf(true)(
  'Nebius.iam.v1.FederationCertificate lifecycle (requires valid SAML federation + X.509 certificate — not practical for automated testing)',
  (stack) =>
  Effect.gen(function* () {
    // Create federation first
    const fed = yield* stack.deploy(
      Nebius.iam.Federation('CertTestFed', {
        samlSettings: {
          idpIssuer: 'https://cert-test.example.com',
          ssoUrl: 'https://cert-test.example.com/sso',
        },
      }),
    )

    // Minimal self-signed cert in PEM format (just for testing — API may reject)
    const certData = `-----BEGIN CERTIFICATE-----
MIIDazCCAlOgAwIBAgIUe0J3mN4G5x7Y2k1L8M9pQ6rRtVw0DQYJKoZIhvcNAQEL
BQAwRTELMAkGA1UEBhMCVVMxEzARBgNVBAgMClNvbWUtU3RhdGUxITAfBgNVBAoM
GEludGVybmV0IFdpZGdpdHMgUHR5IEx0ZDAeFw0yNTAxMDEwMDAwMDBaFw0yNjAx
MDEwMDAwMDBaMEUxCzAJBgNVBAYTAlVTMRMwEQYDVQQIDApTb21lLVN0YXRlMSEw
HwYDVQQKDBhJbnRlcm5ldCBXaWRnaXRzIFB0eSBMdGQwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQC7VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1+fPGp4sNC
n0BLkHLxaqO2sUWTqNFPz9h6tGxNvP3pQRlhQVkY8dNcGhkzP5rNlFw2ZSB6cRJx
hGJ6qN8vL2T3wR5sZxVbNmQ9K4c7fL8mN2wR5sZxVbNmQ9K4c7fL8mN2wR5sZxVb
-----END CERTIFICATE-----`

    const cert = yield* stack.deploy(
      Nebius.iam.FederationCertificate('LifecycleTest', {
        parentId: fed.id as never,
        description: 'Alchemy integration test cert',
        data: certData,
      }),
    )

    expect(cert.id).toBeDefined()
    expect(typeof cert.id).toBe('string')
    expect(cert.description).toBe('Alchemy integration test cert')
  }).pipe(
    Effect.ensuring(stack.destroy().pipe(
      Effect.tapError((e) => Effect.logError(`[cleanup] destroy failed: ${String(e)}`)),
      Effect.ignore,
    )),
  ),
  { timeout: 180_000 },
)
