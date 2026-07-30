import * as BunTest from 'bun:test'
import * as GrpcErrorModule from '../../modules/api-client/grpc-utils.ts'
import * as EndpointsModule from '../../modules/endpoints.ts'

const { describe, expect, test } = BunTest
const { GrpcError, GrpcDeadlineExceededError } = GrpcErrorModule
const { UnknownServiceError } = EndpointsModule

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GrpcError', () => {
  // eslint-disable-next-line no-underscore-dangle
  test('is a TaggedErrorClass with _tag', () => {
    const err = new GrpcError({
      code: 5,
      message: 'Not found',
      details: 'Bucket "my-bucket" does not exist',
    })

    expect(err._tag).toBe('GrpcError')
  })

  test('exposes code, message, and details fields', () => {
    const err = new GrpcError({
      code: 14,
      message: 'Service Unavailable',
      details: 'Connection refused',
    })

    expect(err.code).toBe(14)
    expect(err.message).toBe('Service Unavailable')
    expect(err.details).toBe('Connection refused')
  })

  test('is an instance of Error', () => {
    const err = new GrpcError({ code: 0, message: '', details: '' })
    expect(err).toBeInstanceOf(Error)
  })

  test('code is a finite number (not NaN, Infinity)', () => {
    const err = new GrpcError({ code: 0, message: '', details: '' })
    expect(Number.isFinite(err.code)).toBe(true)
  })

  test('handles zero gRPC status code (OK)', () => {
    const err = new GrpcError({ code: 0, message: '', details: '' })
    expect(err.code).toBe(0)
    expect(err.message).toBe('')
  })

  test('handles common gRPC error codes', () => {
    // NOT_FOUND = 5, ALREADY_EXISTS = 6, PERMISSION_DENIED = 7,
    // UNAUTHENTICATED = 16, INTERNAL = 13
    const codes = [5, 6, 7, 13, 16]
    for (const code of codes) {
      const err = new GrpcError({ code, message: 'test', details: 'test' })
      expect(err.code).toBe(code)
    }
  })
})

// ---------------------------------------------------------------------------
// GrpcDeadlineExceededError
// ---------------------------------------------------------------------------

describe('GrpcDeadlineExceededError', () => {
  // eslint-disable-next-line no-underscore-dangle
  test('is a TaggedErrorClass with _tag', () => {
    const err = new GrpcDeadlineExceededError({
      message: 'Deadline exceeded',
    })

    expect(err._tag).toBe('GrpcDeadlineExceededError')
  })

  test('exposes message field', () => {
    const err = new GrpcDeadlineExceededError({
      message: 'Deadline exceeded before response',
    })

    expect(err.message).toBe('Deadline exceeded before response')
  })

  test('is an instance of Error', () => {
    const err = new GrpcDeadlineExceededError({ message: '' })
    expect(err).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// UnknownServiceError
// ---------------------------------------------------------------------------

describe('UnknownServiceError', () => {
  // eslint-disable-next-line no-underscore-dangle
  test('is a TaggedErrorClass with _tag', () => {
    const err = new UnknownServiceError({
      service: 'nebius.unknown.v1.FakeService',
    })

    expect(err._tag).toBe('UnknownServiceError')
  })

  test('exposes service field', () => {
    const err = new UnknownServiceError({
      service: 'nebius.missing.v1.NonexistentService',
    })

    expect(err.service).toBe('nebius.missing.v1.NonexistentService')
  })

  test('is an instance of Error', () => {
    const err = new UnknownServiceError({ service: '' })
    expect(err).toBeInstanceOf(Error)
  })
})
