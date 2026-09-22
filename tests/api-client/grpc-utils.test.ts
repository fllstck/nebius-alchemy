/**
 * Behavioural tests for `modules/api-client/grpc-utils.ts` — the gRPC plumbing every
 * provider sits on. It was at **24 % branch** coverage (only the error classes were tested)
 * while being the module a deploy cannot do without: callback→Effect conversion, deadline
 * handling, retry policy, operation polling and pagination.
 *
 * The callback-level utilities take plain functions, so they are tested with fakes and no
 * network. `pollOperation` builds its own client from a channel, so it runs against an
 * **in-process** gRPC server on `127.0.0.1:0` — real wire behaviour (status codes, metadata,
 * deadlines) with nothing leaving the machine.
 */
import * as BunTest from 'bun:test'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as grpc from '@grpc/grpc-js'

import {
  GrpcDeadlineExceededError,
  OperationFailedError,
  paginateAll,
  pollOperation,
  withGrpcRetry,
  wrapGrpcClient,
  wrapUnaryCall,
  wrapWithOperationPolling,
  GrpcError,
} from '../../modules/api-client/grpc-utils.ts'
import { OperationServiceService } from '../../schemas/nebius/common/v1/operation_service.ts'
import { Operation } from '../../schemas/nebius/common/v1/operation.ts'
import { Warnings as WarningsProto, Warning_Code } from '../../schemas/nebius/common/v1/warning.ts'

const { afterAll, describe, expect, test } = BunTest

// ---------------------------------------------------------------------------
// Fake unary calls
// ---------------------------------------------------------------------------

/** A `wrapUnaryCall`-shaped fake: succeeds with `response`, or fails with the given gRPC error. */
const unaryCall =
  (result: { error?: Partial<grpc.ServiceError>; response?: unknown }) =>
  // oxlint-disable-next-line no-explicit-any — test fake: the response type is the caller's generic
  (callback: (error: grpc.ServiceError | null, response: any) => void): grpc.ClientUnaryCall => {
    queueMicrotask(() => {
      callback(result.error === undefined ? null : (result.error as grpc.ServiceError), result.response)
    })
    return {
      on: () => undefined,
      cancel: () => undefined,
    } as never
  }

/** A fake that latches its `status` listener, so a test can fire the trailers by hand. */
const statusLatchedCall = <T>(response: T) => {
  const listeners: Array<(status: unknown) => void> = []
  return {
    call: (callback: (error: grpc.ServiceError | null, response: T) => void): grpc.ClientUnaryCall => {
      queueMicrotask(() => callback(null, response))
      return {
        on: (event: string, listener: (arg: never) => void) => {
          if (event === 'status') listeners.push(listener as never)
          return undefined
        },
        cancel: () => undefined,
      } as never
    },
    fireStatus: (status: unknown) => {
      for (const listener of listeners) listener(status)
    },
  }
}

const grpcFailure = (code: number, message: string, details = ''): Partial<grpc.ServiceError> => ({
  code,
  message,
  details,
})

// ---------------------------------------------------------------------------
// wrapUnaryCall
// ---------------------------------------------------------------------------

describe('wrapUnaryCall', () => {
  test('resolves the response on success', async () => {
    const response = { id: 'bucket-1' }
    expect(
      await Effect.runPromise(wrapUnaryCall<{ id: string }>((cb) => unaryCall({ response })(cb))),
    ).toEqual(response)
  })

  test('maps a non-deadline failure to GrpcError with code, message and details', async () => {
    const error = await Effect.runPromise(
      Effect.flip(wrapUnaryCall((cb) => unaryCall({ error: grpcFailure(5, 'Not found', 'bucket "b" missing') })(cb))),
    )

    expect(error._tag).toBe('GrpcError')
    expect((error as GrpcError).code).toBe(5)
    expect((error as GrpcError).message).toBe('Not found')
    expect((error as GrpcError).details).toBe('bucket "b" missing')
  })

  test('a missing `details` becomes an empty string, not undefined', async () => {
    // `details: error.details || ''` — a proto field that must be a string, so an undefined
    // would fail encoding downstream.
    const error = (await Effect.runPromise(
      Effect.flip(
        wrapUnaryCall((cb) => unaryCall({ error: { code: 14, message: 'unavailable' } })(cb)),
      ),
    )) as GrpcError

    expect(error.details).toBe('')
  })

  test('code 4 becomes GrpcDeadlineExceededError, not GrpcError', async () => {
    // The retry policy matches this type explicitly (the code-4 arm of GrpcError would be
    // unreachable through this path), so the distinction is load-bearing.
    const error = await Effect.runPromise(
      Effect.flip(wrapUnaryCall((cb) => unaryCall({ error: grpcFailure(4, 'Deadline exceeded') })(cb))),
    )

    expect(error._tag).toBe('GrpcDeadlineExceededError')
    expect((error as GrpcDeadlineExceededError).message).toBe('Deadline exceeded')
  })

  test('an explicit deadline is set on the call options, with waitForReady', async () => {
    let seen: (grpc.CallOptions & { waitForReady?: boolean }) | undefined
    const before = Date.now()

    await Effect.runPromise(
      wrapUnaryCall(
        (cb, options) => {
          seen = options
          return unaryCall({ response: {} })(cb)
        },
        { deadlineMs: 5_000 },
      ),
    )

    expect(seen?.waitForReady).toBe(true)
    expect(seen?.deadline).toBeInstanceOf(Date)
    expect((seen!.deadline as Date).getTime() - before).toBeGreaterThan(4_000)
  })

  test('the deadline is computed per call, so a long-lived service never sends a stale one', async () => {
    const deadlines: Array<number> = []
    const run = () =>
      Effect.runPromise(
        wrapUnaryCall(
          (cb, options) => {
            deadlines.push((options!.deadline as Date).getTime())
            return unaryCall({ response: {} })(cb)
          },
          { deadlineMs: 1_000 },
        ),
      )

    await run()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await run()

    expect(deadlines).toHaveLength(2)
    expect(deadlines[1]!).toBeGreaterThan(deadlines[0]!)
  })

  test('without a deadlineMs no deadline is sent', async () => {
    let seen: grpc.CallOptions | undefined
    await Effect.runPromise(
      wrapUnaryCall((cb, options) => {
        seen = options
        return unaryCall({ response: {} })(cb)
      }),
    )

    expect(seen?.deadline).toBeUndefined()
  })

  test('interrupting the effect cancels the underlying call', async () => {
    let cancelled = false
    const hanging = wrapUnaryCall((_callback, _options) => {
      return {
        on: () => undefined,
        cancel: () => {
          cancelled = true
        },
      } as never
    })

    const fiber = Effect.runFork(hanging)
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(cancelled).toBe(true)
  })

  test('reports a non-retryable failure once, even with retry configured', async () => {
    let calls = 0
    const error = await Effect.runPromise(
      Effect.flip(
        wrapUnaryCall(
          (cb) => {
            calls += 1
            return unaryCall({ error: grpcFailure(5, 'Not found') })(cb)
          },
          { retry: { maxRetries: 3, initialBackoff: 0 } },
        ),
      ),
    )

    expect(calls).toBe(1)
    expect((error as GrpcError).code).toBe(5)
  })

  test('retries a transient failure and returns the eventual success', async () => {
    let calls = 0
    const result = await Effect.runPromise(
      wrapUnaryCall(
        (cb) => {
          calls += 1
          return unaryCall(
            calls < 3 ? { error: grpcFailure(14, 'unavailable') } : { response: { id: 'ok' } },
          )(cb)
        },
        { retry: { maxRetries: 3, initialBackoff: 0 } },
      ),
    )

    expect(calls).toBe(3)
    expect(result).toEqual({ id: 'ok' })
  })

  /** Capture stderr while `body` runs — the warning path writes out-of-band on purpose. */
  const captureStderr = (body: () => void): string => {
    // Neither `process.stderr.write = …` nor `spyOn(process.stderr, 'write')` intercepts in
    // Bun (verified: the spy records zero calls for a direct write), but the descriptor is
    // configurable, so swap the stream itself and put the original back.
    const written: Array<string> = []
    const original = Object.getOwnPropertyDescriptor(process, 'stderr')
    Object.defineProperty(process, 'stderr', {
      value: {
        write: (chunk: unknown) => {
          written.push(String(chunk))
          return true
        },
      },
      configurable: true,
      writable: true,
    })
    try {
      body()
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'stderr', original)
    }
    return written.join('')
  }

  const warningsBin = (summary: string): Buffer =>
    Buffer.from(
      WarningsProto.encode(
        WarningsProto.fromJSON({
          warnings: [{ code: Warning_Code.CODE_DEPRECATED_ENDPOINT, summary }],
        }),
      ).finish(),
    )

  test('a Nebius warning in the trailers is written to stderr', async () => {
    const { call, fireStatus } = statusLatchedCall({ id: 'b-1' })
    await Effect.runPromise(wrapUnaryCall(call))

    const written = captureStderr(() => {
      fireStatus({
        // grpc-js `metadata.get(key)` returns an array of values — hence the `[0]` in the
        // warning path (a bare buffer here would decode a single byte and throw).
        metadata: { get: (key: string) => (key === 'warning-bin' ? [warningsBin('endpoint is changing')] : []) },
      })
    })

    expect(written).toContain('[Nebius warning] CODE_DEPRECATED_ENDPOINT: endpoint is changing')
  })

  test('the alternate trailer key and the base64 form are handled too', async () => {
    const { call, fireStatus } = statusLatchedCall({ id: 'b-1' })
    await Effect.runPromise(wrapUnaryCall(call))

    const written = captureStderr(() => {
      fireStatus({
        metadata: {
          get: (key: string) =>
            key === 'x-nebius-warning-bin' ? [warningsBin('failover routing').toString('base64')] : [],
        },
      })
    })

    expect(written).toContain('[Nebius warning] CODE_DEPRECATED_ENDPOINT: failover routing')
  })

  test('a malformed warning trailer is ignored, not thrown', async () => {
    const { call, fireStatus } = statusLatchedCall({ id: 'b-1' })
    await Effect.runPromise(wrapUnaryCall(call))

    // Warnings are best-effort diagnostics: a decode failure must never surface to the caller.
    const written = captureStderr(() => {
      fireStatus({ metadata: { get: (key: string) => (key === 'warning-bin' ? [Buffer.from([0x08])] : []) } })
    })

    expect(written).toBe('')
  })
})

// ---------------------------------------------------------------------------
// withGrpcRetry
// ---------------------------------------------------------------------------

describe('withGrpcRetry', () => {
  const failing = (error: () => unknown) => {
    let calls = 0
    return {
      calls: () => calls,
      effect: Effect.flatMap(
        Effect.sync(() => {
          calls += 1
        }),
        () => Effect.fail(error() as never),
      ),
    }
  }

  test('retries a retryable code up to maxRetries (so maxRetries + 1 attempts)', async () => {
    const { effect, calls } = failing(() => new GrpcError({ code: 14, message: 'unavailable', details: '' }))
    await Effect.runPromise(Effect.flip(withGrpcRetry(effect, { maxRetries: 2, initialBackoff: 0 })))

    // attempt 0 and 1 retry; attempt 2 hits the bound and fails.
    expect(calls()).toBe(3)
  })

  test('retries a GrpcDeadlineExceededError (it is not a GrpcError with code 4)', async () => {
    const { effect, calls } = failing(() => new GrpcDeadlineExceededError({ message: 'deadline' }))
    const error = await Effect.runPromise(
      Effect.flip(withGrpcRetry(effect, { maxRetries: 1, initialBackoff: 0 })),
    )

    expect(calls()).toBe(2)
    expect((error as GrpcDeadlineExceededError)._tag).toBe('GrpcDeadlineExceededError')
  })

  test('does not retry a non-retryable code', async () => {
    const { effect, calls } = failing(() => new GrpcError({ code: 7, message: 'permission denied', details: '' }))
    await Effect.runPromise(Effect.flip(withGrpcRetry(effect, { maxRetries: 5, initialBackoff: 0 })))

    expect(calls()).toBe(1)
  })

  test('a non-Error failure passes through untouched', async () => {
    // `catchIf` inspects the error, so a value that is neither GrpcError nor
    // GrpcDeadlineExceededError must not be swallowed or misclassified.
    const error = await Effect.runPromise(
      Effect.flip(
        withGrpcRetry(Effect.fail<string>('plain-string'), { maxRetries: 2, initialBackoff: 0 }),
      ),
    )

    expect(error).toBe('plain-string')
  })

  test('returns the success without retrying', async () => {
    let calls = 0
    const result = await Effect.runPromise(
      withGrpcRetry(
        Effect.sync(() => {
          calls += 1
          return 'done'
        }),
        { maxRetries: 3, initialBackoff: 0 },
      ),
    )

    expect(result).toBe('done')
    expect(calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// wrapGrpcClient
// ---------------------------------------------------------------------------

describe('wrapGrpcClient', () => {
  const descriptor = {
    get: {
      path: '/nebius.test.v1.TestService/Get',
      requestStream: false as const,
      responseStream: false as const,
      requestSerialize: (v: unknown) => v,
      requestDeserialize: (v: unknown) => v,
      responseSerialize: (v: unknown) => v,
      responseDeserialize: (v: unknown) => v,
    },
    listStream: {
      path: '/nebius.test.v1.TestService/ListStream',
      requestStream: false as const,
      responseStream: true as const,
      requestSerialize: (v: unknown) => v,
      requestDeserialize: (v: unknown) => v,
      responseSerialize: (v: unknown) => v,
      responseDeserialize: (v: unknown) => v,
    },
  }

  test('wraps unary methods and skips streaming ones', () => {
    const wrapped = wrapGrpcClient(descriptor, {} as never)

    expect(Object.keys(wrapped)).toEqual(['get'])
  })

  test('passes the request and the call options through, and resolves the response', async () => {
    const seen: Array<{ req: unknown; options: grpc.CallOptions }> = []
    const wrapped = wrapGrpcClient(
      descriptor,
      {
        // The 3-arg overload (req, options, cb): forwarding `CallOptions` is the whole reason
        // the implementation casts around ts-proto's 2-arg client types.
        get: (request: unknown, options: grpc.CallOptions, cb: (e: grpc.ServiceError | null, r: unknown) => void) => {
          seen.push({ req: request, options })
          queueMicrotask(() => cb(null, { id: 'res-1' }))
          return { on: () => undefined, cancel: () => undefined } as never
        },
      } as never,
      { deadlineMs: 1_000 },
    )

    const response = await Effect.runPromise(wrapped.get({ id: 'req-1' }))

    expect(seen).toHaveLength(1)
    expect(seen[0]!.req).toEqual({ id: 'req-1' })
    expect(seen[0]!.options.deadline).toBeInstanceOf(Date)
    expect(response).toEqual({ id: 'res-1' })
  })
})

// ---------------------------------------------------------------------------
// paginateAll
// ---------------------------------------------------------------------------

describe('paginateAll', () => {
  test('follows nextPageToken to exhaustion and concatenates the pages', async () => {
    const tokensRequested: Array<string> = []
    const pages: Record<string, { items: Array<{ id: string }>; nextPageToken: string }> = {
      '': { items: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'page-2' },
      'page-2': { items: [{ id: 'c' }], nextPageToken: '' },
    }

    const items = await Effect.runPromise(
      paginateAll(
        (req: { pageToken: string }) => {
          tokensRequested.push(req.pageToken)
          return Effect.succeed(pages[req.pageToken]!)
        },
        (_parentId: string, pageToken: string) => ({ pageToken }),
        'parent-1',
      ),
    )

    expect(items).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    // The first request carries the empty sentinel, then the token from page 1.
    expect(tokensRequested).toEqual(['', 'page-2'])
  })

  test('a single page with no token stops immediately', async () => {
    let calls = 0
    const items = await Effect.runPromise(
      paginateAll(
        () => {
          calls += 1
          return Effect.succeed({ items: [{ id: 'only' }], nextPageToken: '' })
        },
        () => ({}),
        'parent-1',
      ),
    )

    expect(calls).toBe(1)
    expect(items).toHaveLength(1)
  })

  test('a failing page fails the whole pagination', async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        paginateAll(
          () => Effect.fail(new GrpcError({ code: 13, message: 'internal', details: '' })),
          () => ({}),
          'parent-1',
        ),
      ),
    )

    expect((error as GrpcError).code).toBe(13)
  })
})

// ---------------------------------------------------------------------------
// pollOperation — against an in-process gRPC server
// ---------------------------------------------------------------------------

/**
 * A local OperationService. `responses` is consumed one per Get call; the last one is
 * repeated, so a test can describe "in progress, then done".
 */
const startOperationServer = async (responses: ReadonlyArray<Operation>, error?: Partial<grpc.ServiceError>) => {
  const server = new grpc.Server()
  let calls = 0
  const requests: Array<{ id?: string }> = []
  // ts-proto's generated service definition matches grpc-js's `ServiceDefinition` at runtime.
  server.addService(OperationServiceService, {
    get: (call: { request: { id?: string } }, cb: (error: grpc.ServiceError | null, op: Operation) => void) => {
      const index = Math.min(calls, responses.length - 1)
      requests.push(call.request)
      calls += 1
      if (error !== undefined) {
        cb(error as grpc.ServiceError, undefined as never)
        return
      }
      cb(null, responses[index]!)
    },
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, boundPort) =>
      err ? reject(err) : resolve(boundPort),
    )
  })

  // grpc-js's Channel needs an options object (it dereferences one unconditionally).
  const channel = new grpc.Channel(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), {})
  return {
    transport: { channelFor: (): Effect.Effect<grpc.Channel, never> => Effect.succeed(channel) },
    calls: () => calls,
    requests: () => requests,
    stop: () => {
      channel.close()
      server.forceShutdown()
    },
  }
}

const runningOperation = (): Operation =>
  Operation.fromPartial({
    id: 'operation-1',
    status: { code: 0, message: '' },
  })

const finishedOperation = (code: number, message: string): Operation =>
  Operation.fromPartial({
    id: 'operation-1',
    finishedAt: new Date(),
    status: { code, message },
  })

const servers: Array<() => void> = []
afterAll(() => {
  for (const stop of servers) stop()
})

const withServer = async (responses: ReadonlyArray<Operation>, error?: Partial<grpc.ServiceError>) => {
  const server = await startOperationServer(responses, error)
  servers.push(server.stop)
  return server
}

describe('pollOperation', () => {
  test('returns a finished operation with a zero status', async () => {
    const server = await withServer([finishedOperation(0, '')])

    const op = await Effect.runPromise(pollOperation('operation-1', 'nebius.common.v1.OperationService', server.transport))

    expect(op.id).toBe('operation-1')
    expect(server.calls()).toBe(1)
  })

  test('polls until the operation finishes', async () => {
    const server = await withServer([runningOperation(), runningOperation(), finishedOperation(0, '')])

    const op = await Effect.runPromise(pollOperation('operation-1', 'nebius.common.v1.OperationService', server.transport))

    expect(op.finishedAt).toBeDefined()
    expect(server.calls()).toBe(3)
  })

  test('a finished operation with a non-zero status becomes OperationFailedError', async () => {
    const server = await withServer([finishedOperation(9, 'subnets exist')])

    const error = (await Effect.runPromise(
      Effect.flip(pollOperation('operation-1', 'nebius.common.v1.OperationService', server.transport)),
    )) as OperationFailedError

    expect(error._tag).toBe('OperationFailedError')
    expect(error.operationId).toBe('operation-1')
    expect(error.code).toBe(9)
    expect(error.message).toBe('subnets exist')
  })

  test('an already-expired deadline fails before the first poll', async () => {
    const server = await withServer([runningOperation()])

    const error = (await Effect.runPromise(
      Effect.flip(
        pollOperation('operation-1', 'nebius.common.v1.OperationService', server.transport, {
          deadline: new Date(Date.now() - 1),
        }),
      ),
    )) as GrpcDeadlineExceededError

    expect(error._tag).toBe('GrpcDeadlineExceededError')
    // `after 0 attempts` — the deadline check runs before every attempt, including the first.
    expect(error.message).toContain('after 0 attempts')
    expect(server.calls()).toBe(0)
  })

  test('a failed Get surfaces as GrpcError', async () => {
    const server = await withServer([runningOperation()], grpcFailure(7, 'permission denied', 'no access'))

    const error = (await Effect.runPromise(
      Effect.flip(pollOperation('operation-1', 'nebius.common.v1.OperationService', server.transport)),
    )) as GrpcError

    expect(error._tag).toBe('GrpcError')
    expect(error.code).toBe(7)
    // Pinned as-is, and note the arrangement is the opposite of `wrapUnaryCall`'s: here grpc's
    // `details` (the server's own text) becomes `message`, and grpc's status line becomes
    // `details` (there it is the other way round — both verified against a real client). Both
    // carry the information, so this is documentation rather than a fix: changing either would
    // change every provider's error text.
    expect(error.message).toBe('no access')
    expect(error.details).toContain('PERMISSION_DENIED')
  })

  test('an unresolvable service fails with UnknownServiceError before any call', async () => {
    const transport = {
      channelFor: () => Effect.fail({ _tag: 'UnknownServiceError', service: 'nebius.nope.v1.NopeService' } as never),
    }

    const error = (await Effect.runPromise(
      Effect.flip(pollOperation('operation-1', 'nebius.nope.v1.NopeService', transport)),
    )) as { _tag: string }

    expect(error._tag).toBe('UnknownServiceError')
  })
})

// ---------------------------------------------------------------------------
// The details the first pass left open (mutation survivors)
// ---------------------------------------------------------------------------

describe('pollOperation — error and request details', () => {
  test('the poll request carries the operation id', async () => {
    const server = await withServer([finishedOperation(0, '')])

    await Effect.runPromise(
      pollOperation('operation-42', 'nebius.common.v1.OperationService', server.transport),
    )

    // An empty request would still poll *something*, so this is the assertion that says the
    // id reaches the wire (it also pins `GetOperationRequest.fromPartial({ id })`).
    expect(server.requests()).toEqual([{ id: 'operation-42' }])
  })

  test('code 4 from Get becomes GrpcDeadlineExceededError', async () => {
    const server = await withServer([runningOperation()], grpcFailure(4, 'deadline exceeded'))

    const error = (await Effect.runPromise(
      Effect.flip(pollOperation('operation-1', 'nebius.common.v1.OperationService', server.transport)),
    )) as GrpcDeadlineExceededError

    expect(error._tag).toBe('GrpcDeadlineExceededError')
    // grpc-js renders the status itself (`4 DEADLINE_EXCEEDED: …`), so match the code name
    // rather than the text this test's fake server sent.
    expect(error.message).toContain('DEADLINE_EXCEEDED')
  })
})

describe('withGrpcRetry — defaults', () => {
  test('works with no options at all', async () => {
    // `options?.maxRetries ?? 3` / `options?.initialBackoff ?? 1000` — with no options the
    // non-optional property accesses would throw.
    expect(await Effect.runPromise(withGrpcRetry(Effect.succeed('ok')))).toBe('ok')
  })

  test('retries with the default backoff when no options are given', async () => {
    // The first test never sleeps, so it cannot see a broken default: `initialBackoff ?? 1000`
    // mutated to `&& 1000` yields `undefined`, and `undefined * 2 ** 0` is NaN — the sleep (or
    // the retry) then misbehaves. This one actually takes the retry path with defaults.
    let calls = 0
    const result = await Effect.runPromise(
      withGrpcRetry(
        Effect.suspend(() => {
          calls += 1
          return calls === 1
            ? Effect.fail(new GrpcError({ code: 14, message: 'unavailable', details: '' }))
            : Effect.succeed('recovered')
        }),
      ),
    )

    expect(result).toBe('recovered')
    expect(calls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// wrapWithOperationPolling — the four dispatch arms
// ---------------------------------------------------------------------------

describe('wrapWithOperationPolling', () => {
  /** A raw client whose methods record what they were called with. */
  const rawClient = (calls: Array<string>, logged: { id: string; resourceId: string }) => ({
    create: (req: unknown) => {
      calls.push(`create:${JSON.stringify(req)}`)
      return Effect.succeed(logged)
    },
    remove: (req: unknown) => {
      calls.push(`remove:${JSON.stringify(req)}`)
      return Effect.succeed({ id: logged.id, resourceId: '' })
    },
    fire: (req: unknown) => {
      calls.push(`fire:${JSON.stringify(req)}`)
      return Effect.succeed({ id: 'op-fire', resourceId: '' })
    },
    get: (req: { id?: string }) => {
      calls.push(`get:${req.id}`)
      return Effect.succeed({ id: req.id, name: 'fetched' })
    },
    list: (req: unknown) => {
      calls.push(`list:${JSON.stringify(req)}`)
      return Effect.succeed({ items: [] })
    },
  })

  const configFor = (transport: unknown) => ({
    serviceName: 'nebius.common.v1.OperationService',
    transport,
    polling: ['create'],
    forget: ['remove'],
    fireAndForget: ['fire'],
    getRequest: (id: string) => ({ id }),
  })

  /** The wrapped map is dynamic (one entry per raw method), so the test names the methods it uses. */
  type Wrapped = Record<
    'create' | 'remove' | 'fire' | 'list',
    (req: unknown) => Effect.Effect<unknown, unknown>
  >

  test('each arm does its own thing: poll+fetch, poll-and-forget, fire-and-forget, passthrough', async () => {
    const server = await withServer([finishedOperation(0, ''), finishedOperation(0, '')])
    const calls: Array<string> = []
    const wrapped = wrapWithOperationPolling(
      rawClient(calls, { id: 'operation-1', resourceId: 'bucket-1' }) as never,
      configFor(server.transport) as never,
    ) as unknown as Wrapped

    // `polling`: call → poll the operation → fetch the resource it created.
    expect(await Effect.runPromise(wrapped.create({ name: 'b' }))).toEqual({ id: 'bucket-1', name: 'fetched' })
    expect(calls).toEqual(['create:{"name":"b"}', 'get:bucket-1'])

    // `forget`: call → poll, but return nothing (a delete needs no resource).
    expect(await Effect.runPromise(wrapped.remove({ id: 'bucket-1' }))).toBeUndefined()
    expect(calls.at(-1)).toBe('remove:{"id":"bucket-1"}')
    expect(server.calls()).toBe(2)

    // `fireAndForget`: the raw effect only — no poll request.
    expect(await Effect.runPromise(wrapped.fire({}))).toEqual({ id: 'op-fire', resourceId: '' })
    expect(server.calls()).toBe(2)

    // passthrough: no poll, no transform.
    expect(await Effect.runPromise(wrapped.list({}))).toEqual({ items: [] })
    expect(calls.at(-1)).toBe('list:{}')
  })

  test('a mapInput transform is applied to the polling and passthrough arms', async () => {
    const server = await withServer([finishedOperation(0, '')])
    const calls: Array<string> = []
    const wrapped = wrapWithOperationPolling(
      rawClient(calls, { id: 'operation-1', resourceId: 'bucket-1' }) as never,
      {
        ...configFor(server.transport),
        mapInput: {
          create: (req: { name: string }) => ({ mapped: req.name }),
          list: (req: { limit: number }) => ({ mappedLimit: req.limit }),
        },
      } as never,
    ) as unknown as Wrapped

    await Effect.runPromise(wrapped.create({ name: 'b' }))
    expect(calls[0]).toBe('create:{"mapped":"b"}')

    await Effect.runPromise(wrapped.list({ limit: 5 }))
    expect(calls.at(-1)).toBe('list:{"mappedLimit":5}')
  })
})
