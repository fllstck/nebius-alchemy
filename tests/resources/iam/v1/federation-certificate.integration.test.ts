import * as Effect from 'effect/Effect'
import { Nebius, test } from '../../../helpers/stack.ts'
import { expect } from 'bun:test'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import { integrationTest } from '../../../helpers/gate.ts'

/**
 * Federation certificate lifecycle.
 *
 * Was `skipIf(true)` with the reason only in the test *name* ("requires valid
 * SAML federation + X.509 certificate — not practical for automated testing"):
 * the body shipped a TRUNCATED, invalid PEM, which the API necessarily rejects.
 *
 * It is practical: a self-signed certificate is a complete, valid X.509 input
 * for this resource (nothing validates it against an IdP at creation time), and
 * the SAML settings only need well-formed URLs. The certificate below was
 * generated with
 *
 *   openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
 *     -subj "/CN=alchemy-test-idp/O=Alchemy Test" \
 *     -addext "subjectAltName=DNS:cert-test.example.com"
 *
 * and carries NO private key — rotate it if it ever expires (2036-09-07).
 */
const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIDZzCCAk+gAwIBAgIULE6lFXYt13SedOw6BXYcsJ+ufsswDQYJKoZIhvcNAQEL
BQAwMjEZMBcGA1UEAwwQYWxjaGVteS10ZXN0LWlkcDEVMBMGA1UECgwMQWxjaGVt
eSBUZXN0MB4XDTI2MDkxMDIwMzEwOFoXDTM2MDkwNzIwMzEwOFowMjEZMBcGA1UE
AwwQYWxjaGVteS10ZXN0LWlkcDEVMBMGA1UECgwMQWxjaGVteSBUZXN0MIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq+w/uLGxvT/rcl4TxzwjSHOIaHAm
Ror3rgxC7j5Oi+cyQTcrVHnv9CcCBLUrlhpzK+xGR0F5qinbO0jAUieUGSUP2j0z
LaU7yzLLzB7tUb/QHj/XpRppWskrbNmQ1ned5IbW8xWI4Qofv+wv9Cjv25MNXrFR
uGLiCDwovkTKikOikOCvCJ7KcRlrgSGlq79yg/OGrrkKcRjS2A+dyeDKNrZKcNiX
ui02OAEta6kH+NtjAYoMq84IcU6UYcFkghM2mK2qKTKjDKHbtsLWY0dAWDc53a6I
drQIQdWbCEg9ec2x5b+SbcI0XEYbjQP8Yy73DlGdPkAsdpfjXsiBl34bTwIDAQAB
o3UwczAdBgNVHQ4EFgQUpM0S3evMR+QZn81QyaZz5lPyX88wHwYDVR0jBBgwFoAU
pM0S3evMR+QZn81QyaZz5lPyX88wDwYDVR0TAQH/BAUwAwEB/zAgBgNVHREEGTAX
ghVjZXJ0LXRlc3QuZXhhbXBsZS5jb20wDQYJKoZIhvcNAQELBQADggEBAGAEDaRR
rLDqlstFT57gM4xiXNpO1RElchvWdQPh+/djcL/4pg7I+J0GUTJW2TRrAsrfPcPn
o4hxm6qxNRLRAeivB4Aro230Qljf2QsTzB3MS0Zz7+KEg1HLq+GTh4kPOUQeaktB
0jzpioQVYw10irMn45fatIuIB33ck4c/Bmw0Qj9HTd9+kNOmQo1yd43ji7WUl0OR
QqJq9Z+Q9y49scfUs7ZSmPVOXBTk2pdHXvo8Ex2vtGTIDOtXaAY4zIwSBLMJeY6j
sI688QaeYs7WH2py42CdJXy3sMbrD5gXKRQMnzYYGuF0AwNwwqrxVcydt0hfmc7V
0voTAmIdaRbb2EE=
-----END CERTIFICATE-----`

integrationTest(
  test.provider,
  'Nebius.iam.v1.FederationCertificate lifecycle', (stack) =>
  Effect.gen(function* () {
    const fed = yield* stack.deploy(
      Nebius.iam.Federation('CertTestFed', {
        samlSettings: {
          idpIssuer: 'https://cert-test.example.com',
          ssoUrl: 'https://cert-test.example.com/sso',
        },
      }),
    )

    const cert = yield* stack.deploy(
      Nebius.iam.FederationCertificate('LifecycleTest', {
        parentId: fed.id as never,
        description: 'Alchemy integration test cert',
        data: SELF_SIGNED_CERT,
      }),
    )

    expect(cert.id).toBeDefined()
    expect(typeof cert.id).toBe('string')
    expect(cert.description).toBe('Alchemy integration test cert')
  }).pipe(safeDestroy(stack)),
  { timeout: 180_000 },
)
