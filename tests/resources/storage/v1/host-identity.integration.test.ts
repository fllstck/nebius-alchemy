/**
 * Can a binding HOST IDENTITY actually use S3? (SLOW_TESTS-gated, real infra)
 *
 * `hostIdentity` + `grantBucketAccess` are the two deploy-time halves every
 * Nebius binding relies on: an SA/group/membership/AccessKey in the host's own
 * namespace, plus an AccessPermit for that group on the target bucket. The
 * bindings' own tests either mock the host or use a manually created key in the
 * pre-existing `editors` group, so this exact combination was never exercised —
 * and the hosted-instance e2e found it failing with S3's "The authorization
 * header that you provided is not valid." after the env had been injected.
 *
 * This test isolates the identity/permit path from the VM: deploy the identity,
 * read the very attributes a binding injects into the host env
 * (`awsAccessKeyId` / `secretAccessKey`), and drive real S3 with them.
 */
import * as Effect from 'effect/Effect'
import { expect } from 'bun:test'
import { S3Client } from '@bradenmacdonald/s3-lite-client'
import { Nebius, test } from '../../../helpers/stack.ts'
import { integrationTest } from '../../../helpers/gate.ts'
import { safeDestroy } from '../../../helpers/cleanup.ts'
import { verifyNoBucketLeaks } from '../../../helpers/leaks.ts'
import { hostIdentity, grantBucketAccess } from '../../../../modules/resources/shared/host-identity.ts'

const REGION = process.env.NEBIUS_REGION ?? 'eu-north1'
const PROJECT = process.env.NEBIUS_PROJECT_ID ?? ''
const HOST = 'ProbeHost'
const KEY = 'host-identity-probe.txt'
const PAYLOAD = 'hello-from-host-identity'

integrationTest(
  test.provider,
  'Nebius host identity — injected S3 credentials + bucket grant actually work',
  (stack) =>
    Effect.gen(function* () {
      const { bucketName, accessKeyId, secretAccessKey } = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Nebius.storage.Bucket('ProbeBucket', {
            versioningPolicy: 'DISABLED',
            defaultStorageClass: 'STANDARD',
            objectAuditLogging: 'NONE',
            forceStorageClass: false,
          })
          // Exactly what a binding does at deploy time, for a real host id.
          const identity = yield* hostIdentity(HOST)
          yield* grantBucketAccess(`${HOST}ProbeAccess`, identity, bucket.id, 'storage.editor')
          return {
            bucketName: bucket.name,
            accessKeyId: identity.awsAccessKeyId,
            secretAccessKey: identity.secretAccessKey,
          }
        }),
      )

      console.log(`[IDENTITY] bucket=${bucketName}`)
      console.log(`[IDENTITY] accessKeyId=${accessKeyId?.slice(0, 10)}… secretLength=${secretAccessKey?.length ?? 0}`)
      expect(accessKeyId).toBeTruthy()
      expect(secretAccessKey).toBeTruthy()

      const client = new S3Client({
        endPoint: `https://storage.${REGION}.nebius.cloud`,
        region: REGION,
        accessKey: accessKeyId,
        secretKey: secretAccessKey,
        bucket: bucketName,
        pathStyle: true,
      })

      // Real S3, with retries: IAM/access-key propagation to the S3 front end is
      // eventual (documented in TASKS.md) — a persistent failure is the bug.
      const outcome = yield* Effect.promise(async () => {
        let lastError = ''
        for (let attempt = 1; attempt <= 8; attempt++) {
          try {
            await client.putObject(KEY, PAYLOAD, { metadata: { 'Content-Type': 'text/plain' } })
            const response = await client.getObject(KEY)
            const text = await response.text()
            await client.deleteObject(KEY)
            return `ok:${text}:attempt${attempt}`
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
            if (attempt < 8) await new Promise((resolve) => setTimeout(resolve, 15_000))
          }
        }
        return `error:${lastError}`
      })

      console.log(`[IDENTITY] round-trip: ${outcome}`)
      expect(outcome).toBe(`ok:${PAYLOAD}:attempt1`)
    }).pipe(safeDestroy(stack, verifyNoBucketLeaks(PROJECT))),
  { timeout: 240_000 },
)
