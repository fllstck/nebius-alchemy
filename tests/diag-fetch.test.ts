import * as Effect from 'effect/Effect'
import { Nebius, test } from './helpers/stack.ts'
import { integrationTest } from './helpers/gate.ts'
import { safeDestroy } from './helpers/cleanup.ts'

const BUCKET = 'storagebucket-e0011063956271735218516'

// The EXACT python3 fetch code from the hosted fetch script.
const PY_FETCH = `
import datetime, hashlib, hmac, json, os, sys, urllib.request
from urllib.parse import quote
app_dir, bucket, region, endpoint, manifest_key = sys.argv[1:]
access_key = os.environ["AWS_ACCESS_KEY_ID"]
secret_key = os.environ["AWS_SECRET_ACCESS_KEY"]
def sign(key, msg):
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()
def get_object(key):
    host = endpoint.replace("https://", "").replace("http://", "").split("/")[0]
    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(b"").hexdigest()
    path = "/" + quote(bucket, safe="") + "/" + quote(key, safe="/")
    canonical_headers = "host:{}\\nx-amz-content-sha256:{}\\nx-amz-date:{}\\n".format(host, payload_hash, amz_date)
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical_request = "\\n".join(["GET", path, "", canonical_headers, signed_headers, payload_hash])
    scope = "{}/{}/s3/aws4_request".format(date_stamp, region)
    string_to_sign = "\\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()])
    k = sign(("AWS4" + secret_key).encode("utf-8"), date_stamp)
    k = sign(k, region); k = sign(k, "s3"); k = sign(k, "aws4_request")
    signature = hmac.new(k, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    url = "{}/{}/{}".format(endpoint, quote(bucket, safe=""), quote(key, safe="/"))
    req = urllib.request.Request(url, method="GET")
    req.add_header("x-amz-date", amz_date)
    req.add_header("x-amz-content-sha256", payload_hash)
    req.add_header("Authorization", "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}".format(access_key, scope, signed_headers, signature))
    with urllib.request.urlopen(req) as resp:
        return resp.read()
try:
    get_object(manifest_key)
    print("FETCH_OK")
except urllib.error.HTTPError as e:
    print("HTTP_ERROR", e.code, e.reason)
except Exception as e:
    print("OTHER_ERROR", type(e).__name__, str(e)[:120])
`

integrationTest(
  test.provider,
  'DIAG python SigV4 fetch against the real bucket',
  (stack) =>
    Effect.gen(function* () {
      const { key } = yield* stack.deploy(
        Effect.gen(function* () {
          const sa = yield* Nebius.iam.ServiceAccount('DiagFetch-SA', { description: 'diag fetch' })
          const group = yield* Nebius.iam.Group('DiagFetch-Group')
          yield* Nebius.iam.GroupMembership('DiagFetch-Membership', { parentId: group.id, memberId: sa.id })
          const key = yield* Nebius.iam.AccessKey('DiagFetch-Key', { serviceAccountId: sa.id, secretDeliveryMode: 'INLINE' })
          yield* Nebius.iam.AccessPermit('DiagFetch-Permit', { parentId: group.id, resourceId: BUCKET, role: 'storage.viewer' })
          return { key }
        }),
      )
      const resolvedKey = key as unknown as { awsAccessKeyId: string; secretAccessKey: string }
      const env = {
        ...process.env,
        AWS_ACCESS_KEY_ID: resolvedKey.awsAccessKeyId,
        AWS_SECRET_ACCESS_KEY: resolvedKey.secretAccessKey,
      }
      const proc = Bun.spawn(
        ['python3', '-c', PY_FETCH, '/tmp/diag-fetch', BUCKET, 'eu-north1', 'https://storage.eu-north1.nebius.cloud', 'compute/whatever/manifest.json'],
        { env },
      )
      const output = yield* Effect.promise(() => new Response(proc.stdout).text())
      yield* Effect.promise(() => proc.exited)
      console.log('DIAG python result:', output.trim())
    }).pipe(safeDestroy(stack)),
  { timeout: 4 * 60 * 1000 },
)
