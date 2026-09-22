/**
 * Live-test fixtures too big (or too fiddly) to re-derive per file.
 *
 * `SELF_SIGNED_CERT` is a real X.509 certificate — the IAM federation-certificate API validates the
 * PEM, and the earlier attempt with a truncated body was accepted at plan time and rejected by the
 * platform, so a real certificate is the only useful fixture. It was generated with:
 *
 *     openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
 *       -keyout /dev/null -out cert.pem \
 *       -subj "/CN=alchemy-test-idp/O=Alchemy Test" \
 *       -addext "subjectAltName=DNS:cert-test.example.com"
 *
 * and carries NO private key — rotate it if it ever expires (2036-09-07).
 */
export const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
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

// ---------------------------------------------------------------------------
//
// `RSA_4096_PUBLIC_KEY_A` / `_B` are the ONLY shape `iam/v1 AuthPublicKey` accepts. Measured live
// 2026-09-22 by probing the neighbours, because the API's errors are opaque:
//
// | key | API answer |
// | RSA-4096 | accepted (this fixture) |
// | RSA-2048, RSA-3072 | `3 INVALID_ARGUMENT: Key doesn't fits to any supported algorithms:` |
// | Ed25519, ECDSA P-256, ECDSA P-384 | `3 INVALID_ARGUMENT: Invalid public key data: expected public key in PEM-format` — **misleading**: those ARE valid PEM; the service only parses RSA |
//
// Both are public material (no private half), generated with
// `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 | openssl pkey -pubout`. They are
// embedded rather than generated per run so fixtures do not pay ~2 s of keygen, and so the sweep and
// the unit tests exercise real key material — the placeholder PEMs they used before are exactly what
// hid the algorithm constraint.
export const RSA_4096_PUBLIC_KEY_A = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAudE0/3rHnGfLd5P6X5KZ
zeWRpYoBMKtIC/vcEdZt1lAsiSz+YBLx/NLOwaiml7af2eddfpuF1+AUY15c3oyX
zZ1Q4PmVHLrzOYo3VvssC32+GaD7omu4zWguMYjW9LgAA3penSHKIqIaNr7Vy96Z
DSPd2wATT9HULolWKRJkM1MidWkI7z3WcBaLB7EjTGNPnAPSqgz6iL1OQE2XlYZ4
NducRiWX2GPbeKQLTAzvL15N5Vh50L8iiJcrczFTNk3Iu7o9JiMAIpgDDrmC24WJ
tyJoCAfOP3u/tBd0fRB5EitRgSbh0Xu2JoYS7fC7i9ER5ISNFU/8skDQjMF++0py
D6SrmpcR8St0Pjsd93kh2ol7MxBRAH4HRRHEoJi5lDDPukui6+r0y1u+/kPEbWqn
d69ocY0/ip+TGiFu7vBr1r7ErkyG2J9DW7gRCgNQgMtMDpdulKgbItckH5hHyPiF
AYQEuv8APJoQVknEHEbMS6Mg4g+iIls9CX3XFJNMcsfF/LqLr63v6eSd3XrZ64sb
fZCwY9/xwam1gccqdCFhGzNTK382LFXsGgKfO/k8R4s6Cmwh+YxmYmszpwrFSpWP
ZxD+xMpMwvEZm3+hrCLJnBIRGgzGRhJbm8FH9e0bG+XAgxsoRCFA0ne8w8yEgdqv
uFp64jF681jUYRCwkoG9jxsCAwEAAQ==
-----END PUBLIC KEY-----`

export const RSA_4096_PUBLIC_KEY_B = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAzOwO0SXZCWAntee5dGfB
eqOtKOLCygj56P5Ts/y9Hs7nQUQ3qpmDEUiHFmb6tDO3Aucaw+dnvley8JBKR9RD
eEz7eiu06ptx/3gZvbFdbZvkKVsOpySPQpJEk+ilc5ThwDZjMQt4nZxWo5wnWB1Q
92Ncbl9nK33qEMpVuE5JzI5bGHHMIHBesNBKeQ66QoI9Z1MCqPm7tLBTGLD3I7DU
+F04O3K6eKvnm1P2uKUn6UHhLI1ZGx4VMjwNoEZcNwPF6/lDgAiSG/W0AgVCfzGi
uQQqKL9f/LPCM2LHbOGLeBQPklPRpNqsH8reV1yDKtIwQV/b8mnRWHtsbDH0Eakl
0/eXXSODSfEnSi1Trn7B7hYOjN8LSMkDEIPPGpooLJib/WEIIMwgNhVVi4ygTvE+
/BtIXWLlZzCoHINjz3J2xTmUI7yU4nU/LN/6naCk+o6CFVqAFJrToaW1MRvWIjNq
E9EXN3KxvhvNOAy/QV09WBrleFUOIcK4T6IRSlpnvHJZFbH645cHFiYup3RWeB10
NDCQCk7Af9iOy5QCK5EN8tvrR2BSdHqVED/M48tkHlm4p451AjvHMFEkKXkdLlHO
QHPVetRO37FzRWnutSXN/S95Y3rxSlcy+q7zlEbw67KYcMp6+bMcwihJv/pFyf/F
8TvN4F5IkwpI8c+HQiG8uDUCAwEAAQ==
-----END PUBLIC KEY-----`
