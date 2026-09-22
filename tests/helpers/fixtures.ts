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
