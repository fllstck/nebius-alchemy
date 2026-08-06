import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as grpc from '@grpc/grpc-js'
import { NebiusGrpcTransport } from './GrpcTransport.ts'
import { OperationServiceClient, GetOperationRequest } from '../../schemas/nebius/common/v1/operation_service.ts'
import type { Operation } from '../../schemas/nebius/common/v1/operation.ts'
import type { UnknownServiceError } from '../endpoints.ts'
import { Warnings as WarningsProto, warning_CodeToJSON } from '../../schemas/nebius/common/v1/warning.ts'

// ---------------------------------------------------------------------------
// gRPC error type
// ---------------------------------------------------------------------------

/**
 * Represents a gRPC-level error from a Nebius API call.
 * Wraps the @grpc/grpc-js ServiceError with typed fields.
 */
export class GrpcError extends Schema.TaggedErrorClass<GrpcError>()('GrpcError', {
  /** gRPC status code (e.g. 5 = NOT_FOUND, 6 = ALREADY_EXISTS, etc.) */
  code: Schema.Finite,
  /** Human-readable error details from the server */
  message: Schema.String,
  /** Additional server-provided details */
  details: Schema.String,
}) {}

/**
 * Raised when a gRPC call exceeds its deadline (status code 4 = DEADLINE_EXCEEDED).
 *
 * Separated from {@link GrpcError} so callers can distinguish timeout-related
 * failures from other gRPC errors (e.g. for retry decisions).
 */
export class GrpcDeadlineExceededError extends Schema.TaggedErrorClass<GrpcDeadlineExceededError>()(
  'GrpcDeadlineExceededError',
  {
    message: Schema.String,
  },
) {}

// ---------------------------------------------------------------------------
// Retry logic for transient gRPC failures
// ---------------------------------------------------------------------------

/**
 * gRPC status codes that indicate a transient failure worth retrying.
 *
 * Retryable: DEADLINE_EXCEEDED (4), RESOURCE_EXHAUSTED (8), ABORTED (10),
 * INTERNAL (13), UNAVAILABLE (14), DATA_LOSS (15).
 *
 * Not retryable: INVALID_ARGUMENT (3), NOT_FOUND (5), ALREADY_EXISTS (6),
 * PERMISSION_DENIED (7), FAILED_PRECONDITION (9), OUT_OF_RANGE (11),
 * UNIMPLEMENTED (12), UNAUTHENTICATED (16).
 */
const RETRYABLE_CODES = new Set([4, 8, 10, 13, 14, 15])

/** Options for automatic retry of transient gRPC failures. */
export interface GrpcRetryOptions {
  /** Maximum number of retry attempts (default: 3). */
  readonly maxRetries?: number
  /** Initial backoff in milliseconds (default: 1000). */
  readonly initialBackoff?: number
  /** Maximum backoff in milliseconds (default: 30000). */
  readonly maxBackoff?: number
}

/**
 * Wraps an Effect to automatically retry on transient gRPC failures.
 *
 * Uses exponential backoff with jitter. Non-retryable errors
 * (e.g. NOT_FOUND, PERMISSION_DENIED) are re-raised immediately.
 *
 * @param effect - The gRPC call effect to wrap
 * @param options - Retry configuration
 */
export const withGrpcRetry = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: GrpcRetryOptions,
): Effect.Effect<A, E, R> => {
  const maxRetries = options?.maxRetries ?? 3
  const initial = options?.initialBackoff ?? 1000

  const loop = (attempt: number): Effect.Effect<A, E, R> =>
    effect.pipe(
      // Retry on retryable GrpcError codes, up to maxRetries.
      // DEADLINE_EXCEEDED surfaces as GrpcDeadlineExceededError (not GrpcError
      // with code 4), so it is matched explicitly here.
      // Non-matching errors pass through without retry.
      Effect.catchIf(
        (e) =>
          attempt < maxRetries &&
          (e instanceof GrpcDeadlineExceededError || (e instanceof GrpcError && RETRYABLE_CODES.has(e.code))),
        (_e) => {
          const delay = initial * Math.pow(2, attempt)
          // Jitter: randomize between 50% and 100% of the computed delay
          const jittered = delay * (0.5 + Math.random() * 0.5)
          return Effect.sleep(jittered).pipe(Effect.andThen(loop(attempt + 1)))
        },
      ),
    )

  return loop(0)
}

// ---------------------------------------------------------------------------
// Low-level: callback → Effect
// ---------------------------------------------------------------------------

/**
 * Converts a callback-based gRPC unary call into an Effect.
 *
 * Cancellation of the Effect cancels the underlying gRPC call.
 * gRPC errors are mapped to the typed {@link GrpcError} schema.
 *
 * @param call - Factory that creates the gRPC call. Receives a callback and
 *   optional {@link grpc.CallOptions} (used to pass deadline).
 * @param options - Optional call-level settings.
 * @param options.deadlineMs - Call timeout in milliseconds. The deadline is
 *   computed per call (at call time, not service construction), so a long-lived
 *   service never hands gRPC an already-expired deadline. Deadline-exceeded
 *   errors (code 4) are surfaced as {@link GrpcDeadlineExceededError}.
 */
export const wrapUnaryCall = <T>(
  call: (
    callback: (error: grpc.ServiceError | null, response: T) => void,
    options?: grpc.CallOptions,
  ) => grpc.ClientUnaryCall,
  options?: { deadlineMs?: number; retry?: GrpcRetryOptions },
): Effect.Effect<T, GrpcError | GrpcDeadlineExceededError> => {
  const base: Effect.Effect<T, GrpcError | GrpcDeadlineExceededError> = Effect.callback((resume) => {
    // Deadline is computed per call so it is never stale, even when the
    // service has been alive for longer than the timeout. waitForReady keeps
    // the call queued while the channel is CONNECTING/TRANSIENT_FAILURE
    // instead of failing immediately with a spurious DEADLINE_EXCEEDED.
    // (waitForReady is supported at runtime by @grpc/grpc-js but missing from
    // its CallOptions types — the intersection documents the runtime contract.)
    const callOptions: grpc.CallOptions & { waitForReady?: boolean } = {
      ...(options?.deadlineMs !== undefined ? { deadline: new Date(Date.now() + options.deadlineMs) } : {}),
      waitForReady: true,
    }
    const grpcCall = call(
      (error, response) => {
        if (error) {
          if (error.code === 4) {
            // DEADLINE_EXCEEDED — surface as a distinct typed error
            resume(
              Effect.fail(
                new GrpcDeadlineExceededError({
                  message: error.message,
                }),
              ),
            )
          } else {
            resume(
              Effect.fail(
                new GrpcError({
                  code: error.code,
                  message: error.message,
                  details: error.details || '',
                }),
              ),
            )
          }
        } else {
          resume(Effect.succeed(response))
        }
      },
      callOptions,
    )

    // Extract Nebius warnings from response trailers.
    // The status event fires after the callback, so we log warnings out-of-band
    // to stderr rather than through the Effect channel.
    grpcCall.on('status', (status: grpc.StatusObject) => {
      try {
        // Nebius warnings may be in trailing metadata under various keys.
        // Try common binary-warning keys first.
        const warningsBin =
          status.metadata.get('warning-bin')[0] ??
          status.metadata.get('x-nebius-warning-bin')[0]
        if (warningsBin) {
          const decoded = WarningsProto.decode(
            typeof warningsBin === 'string' ? Buffer.from(warningsBin, 'base64') : (warningsBin as Buffer),
          )
          for (const w of decoded.warnings) {
            const code = w.code !== undefined ? warning_CodeToJSON(w.code) : 'UNKNOWN'
            process.stderr.write(`[Nebius warning] ${code}: ${w.summary}\n`)
          }
        }
      } catch {
        // Silently ignore decode failures — warnings are best-effort diagnostics.
      }
    })

    return Effect.sync(() => grpcCall.cancel())
  })

  // Apply retry logic on the base effect to handle transient gRPC failures.
  // GrpcDeadlineExceededError and non-retryable GrpcError codes pass through.
  if (options?.retry) {
    return withGrpcRetry(base, options.retry)
  }
  return base
}

// ---------------------------------------------------------------------------
// Type-level: extract request/response from ts-proto service descriptors
// ---------------------------------------------------------------------------

/**
 * Shape of a ts-proto service descriptor method entry
 * (from `outputServices=grpc-js`).
 */
type ServiceMethodDef = {
  readonly path: string
  readonly requestStream: boolean
  readonly responseStream: boolean
  readonly requestSerialize: (value: any) => any
  readonly requestDeserialize: (value: any) => any
  readonly responseSerialize: (value: any) => any
  readonly responseDeserialize: (value: any) => any
}

type ServiceDescriptor = Record<string, ServiceMethodDef>

/** Extract the request type from a service method descriptor. */
type ReqOf<M extends ServiceMethodDef> = M extends { requestSerialize: (value: infer R) => any } ? R : never

/** Extract the response type from a service method descriptor. */
type ResOf<M extends ServiceMethodDef> = M extends { responseDeserialize: (value: any) => infer R } ? R : never

/**
 * Given a ts-proto service descriptor (the `*ServiceService` constant),
 * produce an object type where each unary method is mapped to an Effect-
 * wrapped version:
 *
 * ```ts
 * (req: Req) => Effect.Effect<Res, GrpcError | GrpcDeadlineExceededError>
 * ```
 *
 * Streaming methods (client-stream, server-stream, bidi) are excluded.
 */
export type EffectService<S extends ServiceDescriptor> = {
  [K in keyof S as S[K] extends { requestStream: false; responseStream: false } ? K : never]: (
    request: ReqOf<S[K]>,
  ) => Effect.Effect<ResOf<S[K]>, GrpcError | GrpcDeadlineExceededError>
}

// ---------------------------------------------------------------------------
// Runtime: wrap all unary methods of a gRPC client
// ---------------------------------------------------------------------------

/**
 * Wraps every unary method of a gRPC client in an Effect, using the
 * ts-proto service descriptor to determine method names and whether
 * each method is unary.
 *
 * Lower-level building block. Prefer {@link makeGrpcService} for the
 * full pipeline (channel resolution + client construction + wrapping).
 *
 * @param options.deadlineMs - Default call timeout in milliseconds for all
 *   wrapped unary calls. Computed per call (see {@link wrapUnaryCall}).
 */
export const wrapGrpcClient = <S extends ServiceDescriptor>(
  descriptor: S,
  client: Record<string, (req: any, cb: (err: grpc.ServiceError | null, res: any) => void) => grpc.ClientUnaryCall>,
  options?: { deadlineMs?: number; retry?: GrpcRetryOptions },
): EffectService<S> => {
  const wrapped: Record<string, (req: any) => Effect.Effect<any, GrpcError | GrpcDeadlineExceededError>> = {}
  for (const [method, def] of Object.entries(descriptor)) {
    if (!def.requestStream && !def.responseStream) {
      // Cast: ts-proto generated types only expose the 2-arg (req, cb)
      // overload, but @grpc/grpc-js supports (req, options, cb) at runtime.
      // We use the 3-arg overload to pass deadline via CallOptions.
      // `as any` is needed because Record<string, FnA> and Record<string, FnB>
      // are structurally incompatible (index signature variance), even though
      // each method supports the wider overload at runtime.
      wrapped[method] = (req: unknown) =>
        wrapUnaryCall((cb, callOpts) => (client as any)[method]!(req, callOpts ?? {}, cb), options)
    }
  }
  return wrapped as EffectService<S>
}

// ---------------------------------------------------------------------------
// Operation polling for long-running operations
// ---------------------------------------------------------------------------

/**
 * Error raised when a Nebius long-running operation completes
 * with a non-OK status.
 */
export class OperationFailedError extends Schema.TaggedErrorClass<OperationFailedError>()('OperationFailedError', {
  operationId: Schema.String,
  code: Schema.Finite,
  message: Schema.String,
}) {}

/**
 * Poll a Nebius long-running operation until it completes successfully.
 *
 * Uses exponential backoff starting at 500ms, jittered, with a maximum of
 * ~40 retries (≈15 minutes). Automatically routes the operation poll to the
 * correct endpoint via {@link NebiusGrpcTransport} based on the service name
 * that created the operation.
 *
 * Each poll attempt has a 30s deadline to prevent hanging on a stalled
 * operation service.
 *
 * @param operationId - The operation ID returned by create/update/delete
 * @param serviceName - The fully-qualified protobuf service name used for
 *   endpoint resolution (e.g. `"nebius.storage.v1.BucketService"`)
 * @param transport - Transport providing channel resolution
 * @param options.deadline - Overall deadline for the entire polling loop.
 *   Defaults to 5 minutes from now.
 * @returns The completed Operation on success
 */
export const pollOperation = (
  operationId: string,
  serviceName: string,
  transport: { readonly channelFor: (service: string) => Effect.Effect<grpc.Channel, UnknownServiceError> },
  options?: { deadline?: Date; timeout?: number },
): Effect.Effect<Operation, GrpcError | OperationFailedError | GrpcDeadlineExceededError | UnknownServiceError> =>
  Effect.gen(function* () {
    const channel = yield* transport.channelFor(serviceName)

    // createSsl() is defense-in-depth — the channelOverride below already
    // provides a TLS channel, but explicitly requesting SSL ensures a future
    // refactor that drops the override won't silently produce a plaintext
    // connection.
    const client = new OperationServiceClient('unused', grpc.credentials.createSsl(), {
      channelOverride: channel,
    })

    const pollDeadline = options?.deadline ?? new Date(Date.now() + 5 * 60 * 1000)

    const getOperation = (): Effect.Effect<Operation, GrpcError | GrpcDeadlineExceededError> =>
      Effect.callback((resume) => {
        const call = client.get(
          GetOperationRequest.fromPartial({ id: operationId }),
          new grpc.Metadata(),
          // Per-attempt deadline; waitForReady so a reconnecting channel does
          // not fail the poll immediately. (waitForReady is a runtime-supported
          // CallOptions field missing from grpc-js's types.)
          {
            deadline: new Date(Date.now() + 30_000),
            waitForReady: true,
          } as grpc.CallOptions & { waitForReady?: boolean },
          (error, response) => {
            if (error) {
              if (error.code === 4) {
                resume(Effect.fail(new GrpcDeadlineExceededError({ message: error.message })))
              } else {
                resume(
                  Effect.fail(
                    new GrpcError({
                      code: error.code,
                      message: error.details,
                      details: error.message,
                    }),
                  ),
                )
              }
            } else {
              resume(Effect.succeed(response))
            }
          },
        )
        return Effect.sync(() => call.cancel())
      })

    // Poll with jittered exponential backoff, max 40 attempts
    let delay = 500
    for (let attempt = 0; attempt < 40; attempt++) {
      // Check overall deadline before each attempt
      if (Date.now() >= pollDeadline.getTime()) {
        return yield* new GrpcDeadlineExceededError({
          message: `Operation ${operationId} polling timed out after ${attempt} attempts`,
        })
      }

      const op = yield* getOperation()

      // finishedAt is only set when the operation has completed
      if (op.finishedAt) {
        if (op.status && op.status.code !== 0) {
          return yield* new OperationFailedError({
            operationId,
            code: op.status.code,
            message: op.status.message || 'Operation failed',
          })
        }
        return op
      }

      // Operation still in progress — wait with jittered backoff.
      // Jitter: randomize between 50% and 100% of the computed delay
      // to avoid thundering-herd problems when many operations are
      // polling the same endpoint.
      const jittered = delay * (0.5 + Math.random() * 0.5)
      yield* Effect.sleep(jittered)
      delay = Math.min(delay * 2, 30000) // exponential backoff, cap at 30s
    }

    // Exhausted all retries
    return yield* new OperationFailedError({
      operationId,
      code: -1,
      message: 'Operation timed out after 40 polling attempts',
    })
  })

// ---------------------------------------------------------------------------
// Operation-aware service wrapper (type + runtime helper)
// ---------------------------------------------------------------------------

/**
 * Derive an operation-aware service interface from a raw gRPC service type.
 *
 * Methods listed in {@link FetchKeys} become `(req) => Effect<Resource, ...>`
 * (polling is transparent — the caller never sees `Operation`).
 * Methods listed in {@link ForgetKeys} become `(req) => Effect<void, ...>`.
 * All other methods pass through unchanged.
 *
 * {@link Resource} defaults to the return type of `raw.get` when `Raw` has a
 * `get` method. Override it explicitly only when inference fails.
 *
 * @typeParam Raw - Raw {@link EffectService} from a ts-proto service descriptor
 * @typeParam FetchKeys - Method names that return an `Operation` and should
 *   fetch the resource after polling (e.g. `"create" | "update"`)
 * @typeParam ForgetKeys - Method names that return an `Operation` and should
 *   return `void` after polling (e.g. `"delete"`)
 * @typeParam Resource - The resource type returned by FetchKeys methods.
 *   Defaults to {@link ResourceOf `ResourceOf<Raw>`}.
 */
export type WithOperationPolling<
  Raw,
  FetchKeys extends keyof Raw,
  ForgetKeys extends keyof Raw,
  FireForgetKeys extends keyof Raw = never,
  Resource = ResourceOf<Raw>,
> = {
  [K in keyof Raw]: K extends FetchKeys
    ? Raw[K] extends (req: infer Req) => Effect.Effect<infer _Res, infer E, infer C>
      ? (
          req: Req,
        ) => Effect.Effect<Resource, E | OperationFailedError | UnknownServiceError | GrpcDeadlineExceededError, C>
      : Raw[K]
    : K extends ForgetKeys | FireForgetKeys
      ? Raw[K] extends (req: infer Req) => Effect.Effect<infer _Res, infer E, infer C>
        ? (
            req: Req,
          ) => Effect.Effect<void, E | OperationFailedError | UnknownServiceError | GrpcDeadlineExceededError, C>
        : Raw[K]
      : Raw[K]
}

/** Extract the resource type from a service that has a `get` method. */
type ResourceOf<Raw> = Raw extends {
  get: (req: any) => Effect.Effect<infer Res, any, any>
}
  ? Res
  : never

/**
 * Wrap a raw gRPC service so that operation-returning methods
 * (create/update/delete) transparently poll until completion.
 *
 * @param raw - Raw {@link EffectService} with operation-returning methods
 * @param config.serviceName - FQ protobuf service name for endpoint resolution
 * @param config.polling - Method names whose operation is polled, then the
 *   resource is fetched via {@link config.getRequest} and returned
 * @param config.forget - Method names whose operation is polled but the result
 *   is discarded (returns `void`)
 * @param config.fireAndForget - Method names whose operation is NOT polled —
 *   the gRPC call is fired and returns immediately (returns `void`)
 * @param config.getRequest - Given a resource ID (from `operation.resourceId`),
 *   returns the request object for the service's `get` method
 * @returns A service object typed as {@link WithOperationPolling} — no cast needed
 */
export const wrapWithOperationPolling = <
  Raw extends Record<string, (req: any) => Effect.Effect<any, GrpcError | GrpcDeadlineExceededError>>,
  const FPoll extends keyof Raw & string,
  const FForget extends keyof Raw & string,
  const FFireForget extends keyof Raw & string = never,
>(
  raw: Raw,
  config: {
    serviceName: string
    polling: readonly FPoll[]
    forget: readonly FForget[]
    fireAndForget?: readonly FFireForget[]
    getRequest: (id: string) => any
    /** Transport for resolving operation service endpoints during polling. */
    transport: { readonly channelFor: (service: string) => Effect.Effect<grpc.Channel, UnknownServiceError> }
    /**
     * Optional input transformation per method. Called before the raw gRPC
     * call, allowing the service layer to convert simplified inputs into
     * protobuf request objects (via {@code fromPartial}).
     */
    mapInput?: Partial<Record<keyof Raw, (req: any) => any>>
  },
): WithOperationPolling<Raw, FPoll, FForget, FFireForget> => {
  const forgetSet = new Set<string>(config.forget)
  const pollingSet = new Set<string>(config.polling)
  const fireAndForgetSet = new Set<string>(config.fireAndForget ?? [])
  const wrapped: Record<string, (req: any) => Effect.Effect<any, any, any>> = {}
  const transport = config.transport

  for (const key of Object.keys(raw)) {
    const transform = config.mapInput?.[key]
    if (pollingSet.has(key)) {
      wrapped[key] = (req: any) =>
        Effect.gen(function* () {
          const op = yield* raw[key]!(transform ? transform(req) : req)
          yield* pollOperation(op.id, config.serviceName, transport)
          return yield* raw.get!(config.getRequest(op.resourceId))
        })
    } else if (forgetSet.has(key)) {
      wrapped[key] = (req: any) =>
        Effect.gen(function* () {
          const op = yield* raw[key]!(transform ? transform(req) : req)
          yield* pollOperation(op.id, config.serviceName, transport)
        })
    } else if (fireAndForgetSet.has(key)) {
      wrapped[key] = (req: any) => raw[key]!(transform ? transform(req) : req)
    } else {
      wrapped[key] = transform ? (req: any) => raw[key]!(transform(req)) : raw[key]!
    }
  }

  // The wrapped map is built dynamically by iterating Object.keys(raw).
  // TypeScript cannot track this dynamic construction against the mapped
  // type WithOperationPolling<Raw, FPoll, FForget>. The cast upholds the
  // invariant that every key in `raw` has a corresponding entry in `wrapped`
  // with the correct Effect shape (polling, forget, or passthrough).
  return wrapped as unknown as WithOperationPolling<Raw, FPoll, FForget, FFireForget>
}

// ---------------------------------------------------------------------------
// High-level: one-call service construction
// ---------------------------------------------------------------------------

/**
 * Creates an Effect that builds a fully-typed, Effect-wrapped gRPC service.
 *
 * Resolves the channel via {@link NebiusGrpcTransport}, instantiates the
 * generated gRPC client, and wraps every unary method in an Effect.
 *
 * All unary calls get a default 30-second per-call deadline to prevent
 * infinite hangs, and automatically retry transient failures
 * (DEADLINE_EXCEEDED, UNAVAILABLE, …).
 *
 * @example
 * ```ts
 * import { BucketServiceClient } from '../../schemas/nebius/storage/v1/bucket_service.ts'
 *
 * export const StorageGrpcServiceLive = Layer.effect(
 *   StorageGrpcService,
 *   makeGrpcService(BucketServiceClient),
 * )
 * ```
 */
export const makeGrpcService = <S extends ServiceDescriptor>(
  ClientClass: {
    new (...args: any[]): any
    service: S
    serviceName: string
  },
  options?: { deadlineMs?: number; retry?: GrpcRetryOptions },
): Effect.Effect<EffectService<S>, UnknownServiceError, NebiusGrpcTransport> =>
  Effect.gen(function* () {
    const serviceName = ClientClass.serviceName
    const transport = yield* NebiusGrpcTransport
    const channel = yield* transport.channelFor(serviceName)

    // createSsl() is defense-in-depth — the channelOverride below already
    // provides a TLS channel, but explicitly requesting SSL ensures a future
    // refactor that drops the override won't silently produce a plaintext
    // connection.
    const client = new ClientClass('unused', grpc.credentials.createSsl(), {
      channelOverride: channel,
    })

    const deadlineMs = options?.deadlineMs ?? 30_000
    const retry = options?.retry ?? { maxRetries: 3 }
    return wrapGrpcClient(ClientClass.service, client, { deadlineMs, retry })
  }).pipe(Effect.withSpan('makeGrpcService'))

// ---------------------------------------------------------------------------
// Pagination helper
// ---------------------------------------------------------------------------

/**
 * Paginate through a list endpoint, collecting all items.
 *
 * Every Nebius list API follows the same pattern: a request with
 * `parentId`, `pageSize`, and `pageToken`, returning `items` and
 * `nextPageToken`. This helper eliminates the ~19 copies of that loop
 * across service files.
 *
 * @example
 * ```ts
 * const items = yield* paginateAll(
 *   (req) => raw.list(req),
 *   (parentId, pageToken) => ListDisksRequest.fromPartial({ parentId, pageSize: 100, pageToken }),
 *   parentId,
 * )
 * ```
 */
export const paginateAll = <T>(
  listMethod: (req: any) => Effect.Effect<{ items: T[]; nextPageToken: string }, GrpcError | GrpcDeadlineExceededError>,
  makeRequest: (parentId: string, pageToken: string) => any,
  parentId: string,
): Effect.Effect<T[], GrpcError | GrpcDeadlineExceededError> =>
  Effect.gen(function* () {
    const items: T[] = []
    let pageToken = ''
    do {
      const response = yield* listMethod(makeRequest(parentId, pageToken))
      items.push(...response.items)
      pageToken = response.nextPageToken
    } while (pageToken)
    return items
  })
