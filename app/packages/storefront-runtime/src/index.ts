import {
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  HashMap,
  HashSet,
  Option,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from 'effect';
import type { Fiber } from 'effect';

export const OperationFailureSchema = Schema.Literals(['cancelled', 'deadline', 'overloaded', 'body_oversize']);
export type OperationFailure = typeof OperationFailureSchema.Type;

/** Internal lifetime failure; native clients keep their own HTTP error contracts. */
export class OperationError extends Data.TaggedError('OperationError')<{
  readonly cause?: unknown;
  readonly kind: OperationFailure;
}> {
  constructor(kind: OperationFailure, cause?: unknown) {
    super({ cause, kind });
  }

  override get message() {
    return `Storefront operation ${this.kind}`;
  }
}

export const INGRESS_BYTES = 100_000;
export const RESPONSE_BYTES = 8 * 1024 * 1024;
export const ERROR_BYTES = 100_000;
export const OPERATION_TIMEOUT_MS = 30_000;
export const REQUEST_LIMIT = 32;
export const OWNER_WORK_LIMIT = 4;
export const OWNER_WAIT_LIMIT = 32;

interface WorkBudget {
  readonly permits: Semaphore.Semaphore;
  readonly waiting: Ref.Ref<number>;
}

export interface Operation {
  readonly abort: (kind: OperationFailure) => Fiber.Fiber<void>;
  readonly check: () => void;
  /** Effect Clock monotonic milliseconds, never a wall-clock timestamp. */
  readonly deadline: OperationDeadline;
  readonly dispose: () => Fiber.Fiber<void>;
  readonly id: symbol;
  readonly remainingMs: () => number;
  readonly request: Operation | undefined;
  readonly run: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E | OperationError, R>;
  readonly scope: Scope.Closeable;
  readonly signal: AbortSignal;
  readonly wait: (milliseconds: number) => Effect.Effect<void, OperationError>;
  readonly workBudgets: Ref.Ref<HashMap.HashMap<symbol, WorkBudget>>;
}

export interface OperationOptions {
  readonly operation?: Operation | undefined;
  readonly signal?: AbortSignal | undefined;
}

export const requestOperation = (operation: Operation): Operation => operation.request ?? operation;
const isOperationError = Schema.is(Schema.instanceOf(OperationError));
const failureFromSignal = (signal: AbortSignal): OperationError => {
  const cause: unknown = signal.reason;
  return isOperationError(cause) ? cause : new OperationError('cancelled', cause);
};
const monotonicMillis = (clock: Clock.Clock) => Number(clock.monotonicTimeNanosUnsafe()) / 1e6;
// Native sleeps can wake early; only the monotonic clock decides expiry.
const waitUntilDeadline = (clock: Clock.Clock, remainingMs: () => number) =>
  Effect.suspend(() => clock.sleep(Duration.millis(remainingMs()))).pipe(
    Effect.repeat({ while: () => remainingMs() > 0 }),
  );
const monotonicSleepClock = (clock: Clock.Clock): Clock.Clock => ({
  currentTimeMillis: clock.currentTimeMillis,
  currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
  currentTimeNanos: clock.currentTimeNanos,
  currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
  monotonicTimeNanos: clock.monotonicTimeNanos,
  monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
  sleep: (duration) =>
    Effect.suspend(() => {
      const deadline = monotonicMillis(clock) + Duration.toMillis(duration);
      return waitUntilDeadline(clock, () => Math.max(0, deadline - monotonicMillis(clock)));
    }),
});
const Timeout = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Deadline = Schema.Number.check(Schema.isFinite()).pipe(Schema.brand('StorefrontMonotonicDeadline'));
export type OperationDeadline = typeof Deadline.Type;
export const deadlineAfter = Effect.fn('storefront.deadlineAfter')(function* deadlineAfterDuration(
  milliseconds: number,
) {
  yield* Schema.decodeUnknownEffect(Timeout)(milliseconds);
  const clock = yield* Clock.Clock;
  return yield* Schema.decodeUnknownEffect(Deadline)(monotonicMillis(clock) + milliseconds);
});
const WorkLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const WaitLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const checkDeadline = (
  clock: Clock.Clock,
  deadline: number,
  controller: AbortController,
  abort: Operation['abort'],
) => {
  if (!controller.signal.aborted && monotonicMillis(clock) >= deadline) {
    abort('deadline');
  }
  if (controller.signal.aborted) {
    throw failureFromSignal(controller.signal);
  }
};

/** Acquired at the native framework edge; retained resources belong to its Effect Scope. */
export const createOperation = Effect.fn('storefront.createOperation')(function* operationLifetime({
  deadline: parentDeadline,
  parent,
  signal,
  timeoutMs,
}: {
  readonly deadline?: OperationDeadline | undefined;
  readonly parent?: Operation | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
} = {}) {
  const clock = yield* Clock.Clock;
  const services = yield* Effect.context();
  if (timeoutMs !== undefined) {
    yield* Schema.decodeUnknownEffect(Timeout)(timeoutMs);
  }
  if (parentDeadline !== undefined) {
    yield* Schema.decodeUnknownEffect(Deadline)(parentDeadline);
  }
  const now = monotonicMillis(clock);
  const defaultTimeout = parent === undefined && parentDeadline === undefined ? OPERATION_TIMEOUT_MS : Infinity;
  const deadline = yield* Schema.decodeUnknownEffect(Deadline)(
    Math.min(parent?.deadline ?? Infinity, parentDeadline ?? Infinity, now + (timeoutMs ?? defaultTimeout)),
  );
  const controller = new AbortController();
  const scope = yield* Scope.make();
  const closeRequested = yield* Deferred.make<boolean>();
  const closing = Effect.runForkWith(services)(
    Deferred.await(closeRequested).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
  );
  const abort = (kind: OperationFailure) => {
    controller.abort(new OperationError(kind));
    Deferred.doneUnsafe(closeRequested, Effect.succeed(true));
    return closing;
  };
  const cancel = () => {
    abort(signal === undefined ? 'cancelled' : failureFromSignal(signal).kind);
  };
  const check = () => checkDeadline(clock, deadline, controller, abort);
  const checked = Effect.try({
    catch: (cause) => (isOperationError(cause) ? cause : new OperationError('cancelled', cause)),
    try: check,
  });
  const stopped = Effect.callback<never, OperationError>((resume) => {
    const stop = () => resume(Effect.fail(failureFromSignal(controller.signal)));
    if (controller.signal.aborted) {
      stop();
    } else {
      controller.signal.addEventListener('abort', stop, { once: true });
    }
    return Effect.sync(() => controller.signal.removeEventListener('abort', stop));
  });
  const run = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    checked.pipe(
      Effect.andThen(Effect.raceFirst(work, stopped)),
      Effect.tap(() => checked),
      Effect.tapError(() => checked),
    );
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => signal?.removeEventListener('abort', cancel)),
  );
  if (signal?.aborted === true) {
    cancel();
  } else {
    signal?.addEventListener('abort', cancel, { once: true });
    yield* Effect.forkIn(
      waitUntilDeadline(clock, () => Math.max(0, deadline - monotonicMillis(clock))).pipe(
        Effect.andThen(Effect.sync(() => abort('deadline'))),
      ),
      scope,
    );
  }
  const operation: Operation = {
    abort,
    check,
    deadline,
    dispose: () => abort('cancelled'),
    id: Symbol('request'),
    remainingMs: () => Math.max(0, deadline - monotonicMillis(clock)),
    request: parent === undefined ? undefined : requestOperation(parent),
    run,
    scope,
    signal: controller.signal,
    wait: (milliseconds) => run(Effect.sleep(Duration.millis(milliseconds))),
    workBudgets: yield* Ref.make(HashMap.empty<symbol, WorkBudget>()),
  };
  return operation;
});

/** Charge the original request until its Scope closes, not each independently cancellable child. */
export const createAdmission = (limit = REQUEST_LIMIT) => {
  const admitted = Ref.makeUnsafe(HashSet.empty<symbol>());
  return {
    acquire: (operation: Operation) =>
      Effect.gen(function* acquireRequest() {
        yield* Schema.decodeUnknownEffect(WorkLimit)(limit);
        const request = requestOperation(operation);
        yield* operation.run(Effect.void);
        yield* request.run(Effect.void);
        const outcome = yield* Ref.modify(admitted, (requests) => {
          if (HashSet.has(requests, request.id)) {
            return ['existing', requests] as const;
          }
          if (HashSet.size(requests) >= limit) {
            return ['overloaded', requests] as const;
          }
          return ['admitted', HashSet.add(requests, request.id)] as const;
        });
        if (outcome === 'overloaded') {
          yield* Effect.fail(new OperationError('overloaded'));
        }
        if (outcome === 'admitted') {
          yield* Scope.addFinalizer(request.scope, Ref.update(admitted, HashSet.remove(request.id)));
        }
      }).pipe(Effect.uninterruptible),
  };
};

const takePermit = Effect.fn('storefront.takePermit')(function* takeWorkPermit(budget: WorkBudget, waitLimit: number) {
  yield* Effect.acquireRelease(
    Effect.uninterruptibleMask(
      Effect.fn('storefront.waitForPermit')(function* waitForPermit(restore) {
        if (!(yield* Semaphore.takeIfAvailable(budget.permits, 1))) {
          const queued = yield* Ref.modify(budget.waiting, (waiting) =>
            waiting >= waitLimit ? [false, waiting] : [true, waiting + 1],
          );
          if (!queued) {
            yield* Effect.fail(new OperationError('overloaded'));
          }
          yield* restore(Semaphore.take(budget.permits, 1)).pipe(
            Effect.ensuring(Ref.update(budget.waiting, (waiting) => waiting - 1)),
          );
        }
      }),
    ),
    () => Semaphore.release(budget.permits, 1),
    { interruptible: true },
  );
});

/** Per-request permits and a finite waiter count, with interruption-safe scoped release. */
export const createWorkPool = (limit = OWNER_WORK_LIMIT, waitLimit = OWNER_WAIT_LIMIT) => {
  const key = Symbol('owner-work');
  return {
    acquire: (operation: Operation) =>
      operation.run(
        Effect.gen(function* acquireWork() {
          yield* Schema.decodeUnknownEffect(WorkLimit)(limit);
          yield* Schema.decodeUnknownEffect(WaitLimit)(waitLimit);
          const request = requestOperation(operation);
          const budget = yield* Ref.modify(request.workBudgets, (budgets) => {
            const existing = HashMap.get(budgets, key);
            if (Option.isSome(existing)) {
              return [existing.value, budgets];
            }
            const created: WorkBudget = { permits: Semaphore.makeUnsafe(limit), waiting: Ref.makeUnsafe(0) };
            return [created, HashMap.set(budgets, key, created)];
          });
          yield* takePermit(budget, waitLimit);
        }),
      ),
  };
};

/** Pure bounded byte accumulation, shared with the native HttpClient stream. */
export const createByteCollector = (maxBytes: number) => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  return {
    finish: (): Uint8Array<ArrayBuffer> => {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    },
    push: (chunk: Uint8Array) => {
      if (chunk.byteLength > maxBytes - size) {
        throw new OperationError('body_oversize');
      }
      size += chunk.byteLength;
      chunks.push(chunk);
    },
  };
};

export const BodyReadError = Data.TaggedError('BodyReadError')<{ readonly cause: unknown }>;
export type BodyReadFailure = InstanceType<typeof BodyReadError>;

const releaseReader = (operation: Operation) =>
  Effect.fn('storefront.releaseReader')(function* releaseNativeReader(
    acquired: ReadableStreamDefaultReader<Uint8Array> | undefined,
  ) {
    if (acquired !== undefined) {
      yield* Effect.forkDetach(
        Effect.tryPromise({
          catch: (cause) => new BodyReadError({ cause }),
          try: async () => {
            await acquired.cancel(operation.signal.reason);
          },
        }).pipe(Effect.timeout(Duration.millis(operation.remainingMs())), Effect.ignore),
        { startImmediately: true },
      );
      acquired.releaseLock();
    }
  });

const readChunk = (reader: ReadableStreamDefaultReader<Uint8Array>, operation: Operation) =>
  operation.run(
    Effect.tryPromise({
      catch: (cause) => new BodyReadError({ cause }),
      try: async () => await reader.read(),
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(operation.remainingMs()),
        orElse: () => Effect.fail(new OperationError('deadline')),
      }),
      Effect.updateService(Clock.Clock, monotonicSleepClock),
    ),
  );

const consumeReader = Effect.fn('storefront.consumeReader')(function* boundedBytes({
  headers,
  maxBytes,
  operation,
  reader,
}: {
  readonly headers?: Headers | undefined;
  readonly maxBytes: number;
  readonly operation: Operation;
  readonly reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
}) {
  const length = headers?.get('content-length');
  if (length !== null && length !== undefined && Number(length) > maxBytes) {
    return yield* Effect.fail(new OperationError('body_oversize'));
  }
  const collector = createByteCollector(maxBytes);
  if (reader !== undefined) {
    yield* Stream.unfold(reader, (current) =>
      readChunk(current, operation).pipe(
        Effect.map((next) => (next.done ? undefined : ([next.value, current] as const))),
      ),
    ).pipe(
      Stream.runForEach((chunk) =>
        Effect.try({
          catch: (cause) => new OperationError('body_oversize', cause),
          try: () => collector.push(chunk),
        }),
      ),
    );
  }
  return collector.finish();
});

/** Native Web reader boundary; its Scope cancels and releases even a stalled read. */
export const readBytes = (
  source: { readonly body: ReadableStream<Uint8Array> | null; readonly headers?: Headers },
  { maxBytes, operation }: { readonly maxBytes: number; readonly operation: Operation },
): Effect.Effect<Uint8Array<ArrayBuffer>, BodyReadFailure | OperationError> =>
  Effect.scoped(
    Effect.gen(function* ownNativeBody() {
      const reader = yield* Effect.acquireRelease(
        Effect.try({
          catch: (cause) => new BodyReadError({ cause }),
          try: () => source.body?.getReader(),
        }),
        releaseReader(operation),
      );
      return yield* operation.run(consumeReader({ headers: source.headers, maxBytes, operation, reader }));
    }),
  );

export const readJson = (source: Parameters<typeof readBytes>[0], options: Parameters<typeof readBytes>[1]) =>
  readBytes(source, options).pipe(
    Effect.flatMap((bytes) =>
      options.operation.run(
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(new TextDecoder().decode(bytes)),
      ),
    ),
  );

const RetryableUnavailable = Schema.Union([
  Schema.Struct({
    retryable: Schema.Literal(true),
    type: Schema.Literal('https://ontos.dev/problems/gateway-unavailable'),
  }),
  Schema.Struct({ code: Schema.Literal('read_handler_unavailable') }),
]);
const ReloadRequired = Schema.Struct({ type: Schema.Literal('https://ontos.dev/problems/gateway-reload-required') });

/** Only explicit release/read-admission failures authorize a fresh read assertion. */
export const recoverableReadAdmission = (status: number, body: Schema.Json): boolean =>
  (status === 409 && Schema.is(ReloadRequired)(body)) || (status === 503 && Schema.is(RetryableUnavailable)(body));
