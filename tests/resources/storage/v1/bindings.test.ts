import { describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import { S3Errors, type S3Client } from '@bradenmacdonald/s3-lite-client'
import * as Bindings from '../../../../modules/resources/storage/v1/bindings.ts'

describe('Nebius.storage.v1 bindings', () => {
  test('GetObject contract is defined', () => {
    expect(Bindings.GetObject).toBeDefined()
  })

  test('GetObjectHttp layer is defined', () => {
    expect(Bindings.GetObjectHttp).toBeDefined()
  })

  test('PutObject contract is defined', () => {
    expect(Bindings.PutObject).toBeDefined()
  })

  test('PutObjectHttp layer is defined', () => {
    expect(Bindings.PutObjectHttp).toBeDefined()
  })

  describe('tagged errors', () => {
    test('errors are catchable by tag', async () => {
      const result = await Effect.runPromise(
        Effect.fail(new Bindings.ObjectNotFound({ key: 'k', message: 'nope' })).pipe(
          Effect.catchTag('ObjectNotFound', (err) => Effect.succeed(`caught:${err.key}`)),
        ),
      )
      expect(result).toBe('caught:k')
    })

    test('ObjectNotFound carries the key', () => {
      const err = new Bindings.ObjectNotFound({ key: 'jobs/123', message: 'nope' })
      expect(err._tag).toBe('ObjectNotFound')
      expect(err.key).toBe('jobs/123')
    })
  })

  describe('readS3Env', () => {
    const FULL_ENV = {
      NEBIUS_S3_ENDPOINT: 'https://storage.eu-north1.nebius.cloud',
      NEBIUS_REGION: 'eu-north1',
      NEBIUS_ACCESS_KEY_ID: 'AKIA123',
      NEBIUS_SECRET_ACCESS_KEY: 's3cr3t',
      NEBIUS_BUCKET_NAME: 'my-bucket',
    }

    test('resolves a complete env record', async () => {
      const values = await Effect.runPromise(Bindings.readS3Env(FULL_ENV))
      expect(values).toEqual(FULL_ENV)
    })

    test('fails with InvalidCredentials listing the missing names', async () => {
      // flip swaps success/failure — the resolved value is the error itself.
      const error = await Effect.runPromise(
        Effect.flip(Bindings.readS3Env({ NEBIUS_BUCKET_NAME: 'my-bucket' })),
      )
      expect(error._tag).toBe('InvalidCredentials')
      expect(error.missing).toEqual([
        'NEBIUS_S3_ENDPOINT',
        'NEBIUS_REGION',
        'NEBIUS_ACCESS_KEY_ID',
        'NEBIUS_SECRET_ACCESS_KEY',
      ])
    })
  })

  describe('toStorageError', () => {
    test('NoSuchKey maps to ObjectNotFound', () => {
      const err = Bindings.toStorageError(
        'jobs/123',
        new S3Errors.ServerError(404, 'NoSuchKey', 'nope', { key: 'jobs/123' }),
      )
      expect(err._tag).toBe('ObjectNotFound')
      if (err._tag !== 'ObjectNotFound') throw new Error('unreachable')
      expect(err.key).toBe('jobs/123')
    })

    test('NoSuchBucket maps to BucketNotFound', () => {
      const err = Bindings.toStorageError(undefined, new S3Errors.ServerError(404, 'NoSuchBucket', 'nope'))
      expect(err._tag).toBe('BucketNotFound')
    })

    test('AccessDenied maps to AccessDenied', () => {
      const err = Bindings.toStorageError('k', new S3Errors.ServerError(403, 'AccessDenied', 'nope'))
      expect(err._tag).toBe('AccessDenied')
    })

    test('other server errors map to S3Error preserving code and status', () => {
      const err = Bindings.toStorageError('k', new S3Errors.ServerError(500, 'InternalError', 'boom'))
      expect(err._tag).toBe('S3Error')
      if (err._tag !== 'S3Error') throw new Error('unreachable')
      expect(err.code).toBe('InternalError')
      expect(err.statusCode).toBe(500)
    })

    test('client-side S3Error subclasses map to S3Error ClientError', () => {
      const err = Bindings.toStorageError('k', new S3Errors.InvalidObjectNameError('bad'))
      expect(err._tag).toBe('S3Error')
    })

    test('unknown values map to S3Error Unknown', () => {
      const err = Bindings.toStorageError('k', new Error('weird'))
      expect(err._tag).toBe('S3Error')
    })
  })

  describe('putObjectRequest — the s3-lite-client payload seam', () => {
    /**
     * Records the arguments the S3 client was handed. The payload is kept as the live
     * value (no copy) so the assertions can still see buffer/offset identity.
     */
    const makeStubClient = () => {
      const calls: Array<{ key: string; payload: unknown; options: unknown }> = []
      const client = {
        putObject: (key: string, payload: unknown, options: unknown) => {
          calls.push({ key, payload, options })
          return Promise.resolve({ etag: '"etag-1"', versionId: 'v1' })
        },
      } as unknown as S3Client
      return { client, calls }
    }

    const put = async (request: Bindings.PutObjectRequest) => {
      const { client, calls } = makeStubClient()
      const result = await Effect.runPromise(Bindings.putObjectRequest(() => Effect.succeed(client))(request))
      return { result, calls }
    }

    // s3-lite-client 1.0 narrowed `putObject`'s payload to `Uint8Array_`
    // (`Uint8Array<ArrayBuffer>`). These pin the runtime half of that contract: the
    // client must never receive a `SharedArrayBuffer`-backed view, and the bytes must
    // survive the narrowing unchanged.
    test('normalizes a Uint8Array payload to an ArrayBuffer-backed view', async () => {
      const { calls } = await put({ key: 'sub/bytes.bin', value: new Uint8Array([1, 2, 3]) })

      expect(calls).toHaveLength(1)
      expect(calls[0]?.key).toBe('sub/bytes.bin')
      const sent = calls[0]?.payload as Uint8Array
      expect([...sent]).toEqual([1, 2, 3])
      expect(sent.buffer).toBeInstanceOf(ArrayBuffer)
    })

    test('an offset view uploads only its own bytes', async () => {
      const backing = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])
      const { calls } = await put({ key: 'sub/view.bin', value: backing.subarray(2, 5) })

      const sent = calls[0]?.payload as Uint8Array
      expect([...sent]).toEqual([2, 3, 4])
    })

    test('never hands the client a SharedArrayBuffer-backed view', async () => {
      const shared = new Uint8Array(new SharedArrayBuffer(2))
      shared.set([5, 6])
      const { calls } = await put({ key: 'sub/shared.bin', value: shared })

      const sent = calls[0]?.payload as Uint8Array
      expect([...sent]).toEqual([5, 6])
      expect(sent.buffer).toBeInstanceOf(ArrayBuffer)
      expect(sent.buffer).not.toBe(shared.buffer)
    })

    test('passes a string payload through untouched', async () => {
      const { calls } = await put({ key: 'sub/s.txt', value: 'hello' })

      expect(calls[0]?.payload).toBe('hello')
    })

    test('passes a ReadableStream payload through untouched', async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([7]))
          controller.close()
        },
      })
      const { calls } = await put({ key: 'sub/stream.bin', value: stream })

      expect(calls[0]?.payload).toBe(stream)
    })

    test('contentType becomes the Content-Type metadata, and the result is mapped', async () => {
      const { result, calls } = await put({ key: 'k', value: 'x', contentType: 'text/plain' })

      expect(calls[0]?.options).toEqual({ metadata: { 'Content-Type': 'text/plain' } })
      expect(result).toEqual({ etag: '"etag-1"', versionId: 'v1' })
    })
  })
})
