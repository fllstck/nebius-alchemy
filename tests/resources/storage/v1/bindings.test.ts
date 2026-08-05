import { describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import { S3Errors } from '@bradenmacdonald/s3-lite-client'
import * as Bindings from '../../../../modules/resources/storage/v1/bindings'

describe('Nebius.storage.v1 bindings', () => {
  test('GetObject contract is defined', () => {
    expect(Bindings.GetObject).toBeDefined()
  })

  test('GetObjectBinding layer is defined', () => {
    expect(Bindings.GetObjectBinding).toBeDefined()
  })

  test('PutObject contract is defined', () => {
    expect(Bindings.PutObject).toBeDefined()
  })

  test('PutObjectBinding layer is defined', () => {
    expect(Bindings.PutObjectBinding).toBeDefined()
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
})
