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
export class GrpcError extends Schema.TaggedError<GrpcError>()('GrpcError', {
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
export class GrpcDeadlineExceededError extends Schema.TaggedError<GrpcDeadlineExceededError>()(
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

/** gRPC codes that can hide a successful create (see {@link isCreateRecoveryCandidate}). */
const CREATE_RECOVERY_CODES = new Set([6, 10, 13, 14])

/**
 * Whether a create failure is worth a get-by-name recovery lookup (ISSUES.md R-20).
 *
 * A create can fail *after* the server has already created the resource — the long-running
 * operation is created server-side before the response reaches us — so a get-by-name lookup can
 * recover a resource nothing would otherwise track (and that destroy would then leak). Only
 * these outcomes can hide a successful create:
 *
 * - `DEADLINE_EXCEEDED` (4) — surfaces as {@link GrpcDeadlineExceededError}, never as a
 *   {@link GrpcError} with code 4 (see `wrapUnaryCall`);
 * - `ALREADY_EXISTS` (6) — the resource exists, and the lookup adopts it;
 * - `ABORTED` (10), `INTERNAL` (13), `UNAVAILABLE` (14) — the operation may have been applied
 *   before the failure was reported.
 *
 * Anything else (`INVALID_ARGUMENT`, `NOT_FOUND`, `PERMISSION_DENIED`, …) means the create
 * genuinely did not land: a lookup there can only produce a wrong diagnosis, so callers re-raise
 * it immediately.
 */
export const isCreateRecoveryCandidate = (error: unknown): boolean =>
  error instanceof GrpcDeadlineExceededError ||
  (error instanceof GrpcError && CREATE_RECOVERY_CODES.has(error.code))

/** Options for automatic retry of transient gRPC failures. */
export interface GrpcRetryOptions {
  /** Maximum number of retry attempts (default: 3). */
  readonly maxRetries?: number
  /** Initial backoff in milliseconds (default: 1000). */
  readonly initialBackoff?: number
  /**
   * Cap on the backoff in milliseconds (default: 30_000).
   *
   * Applied to the delay **before** jitter, so it bounds the wait rather than the observed sleep
   * exactly (jitter scales the capped value down to 50–100 %). Until 2026-09-25 this option was
   * documented, exported and *never read* — the loop computed `initialBackoff * 2 ** attempt`
   * uncapped, so setting it bounded nothing, and no test could see it because every retry test
   * passed `initialBackoff: 0` (R-03).
   */
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
  const maxBackoff = options?.maxBackoff ?? 30_000

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
          // Exponential, capped, then jittered. The cap is what makes `maxBackoff` real; the
          // `min` is the whole fix for R-03 and is pinned by two TestClock tests in
          // `tests/api-client/grpc-utils.test.ts` (one for an explicit cap, one for the default).
          const delay = Math.min(initial * Math.pow(2, attempt), maxBackoff)
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
 * Method-name prefixes whose methods only READ, and are therefore safe to retry.
 *
 * The retry policy used to apply to **every** unary method, on the theory that the
 * `x-idempotency-key` header (minted by the channel's metadata generator) made retried mutations safe.
 * It does not — the Nebius API does not dedupe on that header at all. Measured 2026-09-25
 * (`spikes/idempotency-key-probe.ts`, `iam/v1 StaticKey.Issue`, UUID keys): a second `Issue` carrying
 * the **same** key and the **same** request answered `6 ALREADY_EXISTS` rather than the first response
 * — after the first operation had completed *and* while it was still in flight. The key is
 * audit/convention only (the gosdk also mints a fresh one per request).
 *
 * So a retried mutation is simply a second request, and what happens next is whatever uniqueness the
 * resource happens to have: a `Create`/`Issue` answers `ALREADY_EXISTS` (the resource exists, but the
 * client never saw it — an orphan), and a resource without name uniqueness would double-apply. No
 * mutation is therefore retried; a bounded retry only ever runs for a read.
 *
 * Unknown verbs are treated as mutations (not retried) on purpose: a read that loses its retry is a
 * small resilience loss, while a mutation that gains one is a duplicate write.
 */
const RETRYABLE_READ_PREFIXES = ['get', 'list', 'find', 'search', 'batchGet', 'estimate', 'preflight', 'describe'] as const

/**
 * Reads that must NOT be retried, because calling them twice is not idempotent.
 *
 * `getSecretOnce` is the one in this API family: the secret is handed out **once**, so a retry after a
 * lost response comes back empty and that credential can never be recovered. It is a read by name only.
 */
const NON_IDEMPOTENT_READS: ReadonlySet<string> = new Set(['getSecretOnce'])

/**
 * Whether a descriptor method name is a read that may be retried.
 *
 * Exported so the classification (and its two traps — unknown verbs and `getSecretOnce`) is
 * unit-testable without a network, rather than only observable through a retrying call.
 */
export const isRetryableReadMethod = (method: string): boolean => {
  if (NON_IDEMPOTENT_READS.has(method)) return false
  const lower = method.toLowerCase()
  return RETRYABLE_READ_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase()))
}

/**
 * Wraps every unary method of a gRPC client in an Effect, using the
 * ts-proto service descriptor to determine method names and whether
 * each method is unary.
 *
 * Retries are applied to reads only ({@link isRetryableReadMethod}); mutations are attempted exactly
 * once. See {@link RETRYABLE_READ_PREFIXES} for the measurement behind that.
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
      // Reads retry as configured; EVERYTHING else is capped at 0 retries so the call is attempted
      // exactly once (a mutation re-sent is a mutation applied twice — see RETRYABLE_READ_PREFIXES).
      const retry = isRetryableReadMethod(method) ? options?.retry : { ...options?.retry, maxRetries: 0 }
      // Cast: ts-proto generated types only expose the 2-arg (req, cb)
      // overload, but @grpc/grpc-js supports (req, options, cb) at runtime.
      // We use the 3-arg overload to pass deadline via CallOptions.
      // `as any` is needed because Record<string, FnA> and Record<string, FnB>
      // are structurally incompatible (index signature variance), even though
      // each method supports the wider overload at runtime.
      wrapped[method] = (req: unknown) =>
        wrapUnaryCall((cb, callOpts) => (client as any)[method]!(req, callOpts ?? {}, cb), { ...options, retry })
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
export class OperationFailedError extends Schema.TaggedError<OperationFailedError>()('OperationFailedError', {
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

    const pollWindowMs = Math.max(0, pollDeadline.getTime() - Date.now())
    // The deadline is the binding constraint; the attempt cap only guards
    // against a pathological non-expiring deadline. Worst case the loop makes
    // ~2 attempts/sec (500ms backoff floor), so derive the cap from the window
    // instead of a fixed 40 — a 20-minute budget would otherwise exhaust 40
    // attempts (~12 min with capped 30s backoff) before the deadline fires.
    const maxAttempts = Math.max(40, Math.ceil(pollWindowMs / 500))
    let delay = 500
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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

    // Exhausted the attempt budget without the deadline firing (should not
    // happen — the deadline check above is the primary bound).
    return yield* new OperationFailedError({
      operationId,
      code: -1,
      message: `Operation ${operationId} polling exhausted ${maxAttempts} attempts before its deadline`,
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
     * Overall deadline for operation polling in milliseconds
     * (default: 5 minutes). Long-running provisioning (e.g. VM-backed
     * endpoints) can exceed the default — raise per service.
     */
    pollDeadlineMs?: number
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
          yield* pollOperation(op.id, config.serviceName, transport, {
            deadline: new Date(Date.now() + (config.pollDeadlineMs ?? 5 * 60 * 1000)),
          })
          return yield* raw.get!(config.getRequest(op.resourceId))
        })
    } else if (forgetSet.has(key)) {
      wrapped[key] = (req: any) =>
        Effect.gen(function* () {
          const op = yield* raw[key]!(transform ? transform(req) : req)
          yield* pollOperation(op.id, config.serviceName, transport, {
            deadline: new Date(Date.now() + (config.pollDeadlineMs ?? 5 * 60 * 1000)),
          })
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
 * infinite hangs. Transient failures (DEADLINE_EXCEEDED, UNAVAILABLE, …) are retried on **reads
 * only** — a mutation is attempted exactly once, because the API does not dedupe a retried request
 * (see `isRetryableReadMethod`).
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
 * Page bound for {@link paginateAll}: 1000 pages at the usual `pageSize` of 100 is 100k items, so a
 * caller that reaches this is not paginating — it is looping.
 */
export const MAX_PAGES = 1000

/**
 * The endpoint kept offering a page token instead of finishing.
 *
 * Raised as a **defect** by {@link paginateAll} (hence not part of any service's error channel); see
 * that function for why a broken-server condition is not a typed failure here.
 */
export class PaginationLoopError extends Schema.TaggedError<PaginationLoopError>()('PaginationLoopError', {
  /** The token the endpoint returned twice, or the last token when the page bound was hit. */
  pageToken: Schema.String,
  /** Pages fetched before the loop was stopped. */
  pages: Schema.Finite,
  message: Schema.String,
}) {}

/**
 * Paginate through a list endpoint, collecting all items.
 *
 * Every Nebius list API follows the same pattern: a request with
 * `parentId`, `pageSize`, and `pageToken`, returning `items` and
 * `nextPageToken`. This helper eliminates the ~19 copies of that loop
 * across service files.
 *
 * **Termination is guarded.** A list endpoint that answers with the same `nextPageToken` it was given
 * — or that simply never stops — used to loop forever: `do { … } while (pageToken)` had neither a
 * repeat check nor a bound, so one misbehaving endpoint was an unbounded allocator, and its only
 * caller is every provider's `list` (i.e. `alchemy unsafe nuke`). A repeated token, and a page count
 * above {@link MAX_PAGES}, therefore stop the loop immediately.
 *
 * They stop it as a **defect** carrying a {@link PaginationLoopError}, not as a typed failure. The
 * request was well-formed and the server broke its own contract, so no caller has a recovery to
 * offer — while typing it would widen the error channel of all 49 `paginateAll` call sites (every
 * `list` in every service, and everything that composes them) for a condition none of them can act
 * on. A defect still fails loudly, naming the token and the page count.
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
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) {
        return yield* Effect.die(
          new PaginationLoopError({
            pageToken,
            pages: page,
            message: `paginateAll asked for page ${page + 1} of parent ${parentId} — a list endpoint that has not terminated after ${MAX_PAGES} pages is not going to.`,
          }),
        )
      }

      const response = yield* listMethod(makeRequest(parentId, pageToken))
      items.push(...response.items)

      const nextPageToken = response.nextPageToken
      if (!nextPageToken) return items
      if (nextPageToken === pageToken) {
        return yield* Effect.die(
          new PaginationLoopError({
            pageToken: nextPageToken,
            pages: page + 1,
            message: `paginateAll was offered the same page token twice ('${nextPageToken}') for parent ${parentId} — the endpoint is looping.`,
          }),
        )
      }
      pageToken = nextPageToken
    }
  })
