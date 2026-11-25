import { Clock, Deferred, Duration, Effect, Exit, Fiber, Ref, Schema, Scope } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import {
  createAdmission,
  BodyReadError,
  createByteCollector,
  createOperation,
  createWorkPool,
  deadlineAfter,
  ERROR_BYTES,
  INGRESS_BYTES,
  OWNER_WAIT_LIMIT,
  OWNER_WORK_LIMIT,
  readBytes,
  readJson,
  recoverableReadAdmission,
  REQUEST_LIMIT,
  requestOperation,
  RESPONSE_BYTES,
} from '../src/index.ts';
import type { BodyReadFailure, Operation, OperationError } from '../src/index.ts';

const operationFixture = (options: Parameters<typeof createOperation>[0] = {}) =>
  Effect.acquireRelease(createOperation(options), (operation) => Effect.sync(operation.dispose));

const chunksBody = (chunks: readonly Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

const holdPermit = (pool: ReturnType<typeof createWorkPool>, operation: Operation) =>
  Effect.gen(function* heldPermit() {
    const scope = yield* Scope.make();
    yield* Scope.addFinalizer(yield* Scope.Scope, Scope.close(scope, Exit.void));
    yield* Scope.provide(pool.acquire(operation), scope);
    return Scope.close(scope, Exit.void);
  });

it.effect('chunked multibyte JSON counts bytes, including a split UTF-8 sequence', () =>
  Effect.gen(function* multibyteBody() {
    const operation = yield* operationFixture();
    const value = { value: 'ž'.repeat(20) };
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Struct({ value: Schema.String })))(value);
    const bytes = new TextEncoder().encode(encoded);
    const chunks = [bytes.subarray(0, 13), bytes.subarray(13)];
    expect(yield* readJson({ body: chunksBody(chunks) }, { maxBytes: bytes.length, operation })).toEqual(value);
    expect(
      yield* Effect.flip(readJson({ body: chunksBody(chunks) }, { maxBytes: bytes.length - 1, operation })),
    ).toMatchObject({ kind: 'body_oversize' });
  }),
);

it.effect('rejects the excess chunk before retaining it and bounds ingress, success and error bodies', () =>
  Effect.gen(function* byteLimits() {
    const operation = yield* operationFixture();
    for (const maxBytes of [INGRESS_BYTES, ERROR_BYTES, RESPONSE_BYTES]) {
      const collector = createByteCollector(maxBytes);
      collector.push(new Uint8Array(maxBytes));
      expect(() => collector.push(new Uint8Array(1))).toThrow();
      expect(collector.finish().byteLength).toBe(maxBytes);
      expect(
        yield* Effect.flip(
          readBytes({ body: chunksBody([new Uint8Array(maxBytes), new Uint8Array(1)]) }, { maxBytes, operation }),
        ),
      ).toMatchObject({ kind: 'body_oversize' });
    }
  }),
);

it.effect('rejects oversized Content-Length and still bounds a lying small header', () =>
  Effect.gen(function* declaredLength() {
    const operation = yield* operationFixture();
    expect(
      yield* Effect.flip(
        readBytes({ body: null, headers: new Headers({ 'content-length': '101' }) }, { maxBytes: 100, operation }),
      ),
    ).toMatchObject({ kind: 'body_oversize' });
    expect(
      yield* Effect.flip(
        readBytes(
          { body: chunksBody([new Uint8Array(101)]), headers: new Headers({ 'content-length': '1' }) },
          { maxBytes: 100, operation },
        ),
      ),
    ).toMatchObject({ kind: 'body_oversize' });
    expect(yield* readBytes({ body: null }, { maxBytes: 100, operation })).toHaveLength(0);
  }),
);

it.effect('a body stalled after headers shares the operation deadline and cancels its reader', () =>
  Effect.gen(function* stalledBody() {
    const operation = yield* operationFixture({ timeoutMs: 150 });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      start: (controller) => controller.enqueue(new TextEncoder().encode('{"value":')),
    });
    const reading = yield* Effect.forkChild(readBytes({ body }, { maxBytes: 100, operation }).pipe(Effect.flip));
    yield* TestClock.adjust(Duration.millis(150));
    expect(yield* Fiber.join(reading)).toMatchObject({ kind: 'deadline' });
    expect(body.locked).toBe(false);
    expect(cancelled).toBe(true);
  }),
);

for (const deadlineOwner of ['operation timer', 'body read timeout'] as const) {
  it.effect(`${deadlineOwner} does not expire when a fractional sleep wakes before its monotonic deadline`, () =>
    Effect.gen(function* earlyDeadlineWake() {
      const clock = yield* Clock.Clock;
      const earlyClock = {
        currentTimeMillis: clock.currentTimeMillis,
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
        currentTimeNanos: clock.currentTimeNanos,
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        sleep: (duration: Duration.Duration) => {
          const milliseconds = Duration.toMillis(duration);
          return clock.sleep(Duration.millis(milliseconds >= 1 ? Math.floor(milliseconds) : milliseconds));
        },
      } satisfies Clock.Clock;
      const operation = yield* operationFixture({ timeoutMs: 10.9 }).pipe(
        Effect.provideService(
          Clock.Clock,
          deadlineOwner === 'operation timer' ? earlyClock : { ...earlyClock, sleep: () => Effect.never },
        ),
      );
      const body = new ReadableStream<Uint8Array>();
      const work =
        deadlineOwner === 'operation timer'
          ? operation.run(Effect.never)
          : readBytes({ body }, { maxBytes: 100, operation });
      const running = yield* Effect.forkChild(Effect.flip(work).pipe(Effect.provideService(Clock.Clock, earlyClock)));
      yield* TestClock.adjust(Duration.millis(10));
      expect(operation.remainingMs()).toBeCloseTo(0.9);
      expect(operation.signal.aborted).toBe(false);
      expect(running.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(Duration.millis(0.9));
      expect(yield* Fiber.join(running)).toMatchObject({ kind: 'deadline' });
      expect(operation.remainingMs()).toBe(0);
      expect(body.locked).toBe(false);
    }),
  );
}

it.effect('caller cancellation interrupts backoff without resetting the monotonic budget', () =>
  Effect.gen(function* cancelBackoff() {
    const caller = new AbortController();
    const operation = yield* operationFixture({ signal: caller.signal, timeoutMs: 10_000 });
    const { deadline } = operation;
    const waiting = yield* Effect.forkChild(Effect.flip(operation.wait(10_000)));
    caller.abort();
    expect(yield* Fiber.join(waiting)).toMatchObject({ kind: 'cancelled' });
    expect(operation.deadline).toBe(deadline);
  }),
);

it.effect('admission charges one parent request across independent children until disposal', () =>
  Effect.gen(function* requestIdentity() {
    const admission = createAdmission(1);
    const request = yield* operationFixture();
    const child = yield* operationFixture({ parent: request });
    const grandchild = yield* operationFixture({ parent: child });
    const other = yield* operationFixture();
    expect(requestOperation(grandchild)).toBe(request);
    yield* admission.acquire(request);
    yield* admission.acquire(request);
    yield* admission.acquire(child);
    child.dispose();
    expect(yield* Effect.flip(admission.acquire(other))).toMatchObject({ kind: 'overloaded' });
    request.dispose();
    yield* admission.acquire(other);
  }),
);

it.effect('admits exactly 32 requests, with four active and 32 queued owner calls per request', () =>
  Effect.gen(function* capacityBounds() {
    const admission = createAdmission();
    const pool = createWorkPool();
    const requests = yield* Effect.forEach(Array.from({ length: REQUEST_LIMIT + 1 }), () => operationFixture());
    for (const request of requests.slice(0, REQUEST_LIMIT)) {
      yield* admission.acquire(request);
    }
    const first = requests.at(0);
    const second = requests.at(1);
    const overflow = requests.at(REQUEST_LIMIT);
    if (first === undefined || second === undefined || overflow === undefined) {
      yield* Effect.die('Missing request fixture');
      return;
    }
    expect(yield* Effect.flip(admission.acquire(overflow))).toMatchObject({ kind: 'overloaded' });
    const releases = yield* Effect.forEach(Array.from({ length: OWNER_WORK_LIMIT }), () => holdPermit(pool, first));
    const queued = yield* Effect.forEach(Array.from({ length: OWNER_WAIT_LIMIT }), () =>
      Effect.forkChild(Effect.scoped(pool.acquire(first))),
    );
    yield* TestClock.adjust(Duration.zero);
    expect(yield* Effect.flip(Effect.scoped(pool.acquire(first)))).toMatchObject({ kind: 'overloaded' });
    yield* Effect.scoped(pool.acquire(second));
    yield* Fiber.interrupt(queued[0]);
    const replacement = yield* Effect.forkChild(Effect.scoped(pool.acquire(first)));
    yield* TestClock.adjust(Duration.zero);
    for (const release of releases) {
      yield* release;
    }
    for (const waiting of queued.slice(1)) {
      yield* Fiber.join(waiting);
    }
    yield* Fiber.join(replacement);
    yield* Effect.scoped(pool.acquire(first));
  }),
);

it.effect('queued child cancellation removes its waiter without consuming a future permit', () =>
  Effect.gen(function* cancelQueuedChild() {
    const pool = createWorkPool(1, 1);
    const request = yield* operationFixture();
    const child = yield* operationFixture({ parent: request });
    const release = yield* holdPermit(pool, request);
    const queued = yield* Effect.forkChild(Effect.flip(Effect.scoped(pool.acquire(child))));
    yield* TestClock.adjust(Duration.zero);
    expect(yield* Effect.flip(Effect.scoped(pool.acquire(request)))).toMatchObject({ kind: 'overloaded' });
    child.dispose();
    expect(yield* Fiber.join(queued)).toMatchObject({ kind: 'cancelled' });
    const replacement = yield* Effect.forkChild(Effect.scoped(pool.acquire(request)));
    yield* release;
    yield* Fiber.join(replacement);
    yield* Effect.scoped(pool.acquire(request));
  }),
);

it.effect('queued work shares its original deadline and releases queue capacity', () =>
  Effect.gen(function* expireQueuedChild() {
    const pool = createWorkPool(1, 1);
    const request = yield* operationFixture();
    const child = yield* operationFixture({ parent: request, timeoutMs: 100 });
    const release = yield* holdPermit(pool, request);
    const waiting = yield* Effect.forkChild(Effect.flip(Effect.scoped(pool.acquire(child))));
    yield* TestClock.adjust(Duration.millis(100));
    expect(yield* Fiber.join(waiting)).toMatchObject({ kind: 'deadline' });
    const replacement = yield* Effect.forkChild(Effect.scoped(pool.acquire(request)));
    yield* release;
    yield* Fiber.join(replacement);
  }),
);

it.effect('dispose aborts outstanding siblings and is idempotent', () =>
  Effect.gen(function* disposeSiblings() {
    const operation = yield* operationFixture();
    const sibling = yield* Effect.forkChild(Effect.flip(operation.wait(10_000)));
    operation.dispose();
    expect(yield* Fiber.join(sibling)).toMatchObject({ kind: 'cancelled' });
    expect(() => operation.check()).toThrow();
    operation.dispose();
    expect(operation.signal.aborted).toBe(true);
  }),
);

it.effect('children inherit the exact monotonic deadline and only explicitly linked cancellation', () =>
  Effect.gen(function* inheritDeadline() {
    const parent = yield* operationFixture({ timeoutMs: 60_000 });
    const linked = yield* operationFixture({ parent, signal: parent.signal });
    const independent = yield* operationFixture({ parent });
    yield* TestClock.adjust(Duration.seconds(1));
    expect(linked.deadline).toBe(parent.deadline);
    expect(independent.deadline).toBe(parent.deadline);
    expect(parent.remainingMs()).toBe(59_000);
    parent.abort('cancelled');
    expect(() => linked.check()).toThrow();
    independent.check();
    expect(independent.remainingMs()).toBe(59_000);
    yield* TestClock.adjust(Duration.seconds(59));
    expect(yield* Effect.flip(independent.run(Effect.void))).toMatchObject({ kind: 'deadline' });
  }),
);

it.effect('already-aborted callers fail before dispatch and explicit deadline failure retains its kind', () =>
  Effect.gen(function* preCancelled() {
    const parent = yield* operationFixture();
    parent.abort('deadline');
    const child = yield* operationFixture({ parent, signal: parent.signal });
    const dispatched = yield* Ref.make(0);
    expect(yield* Effect.flip(child.run(Ref.update(dispatched, (count) => count + 1)))).toMatchObject({
      kind: 'deadline',
    });
    expect(yield* Ref.get(dispatched)).toBe(0);
  }),
);

it.effect('deadline expiry releases request admission even with no running transport', () =>
  Effect.gen(function* idleAdmission() {
    const admission = createAdmission(1);
    const first = yield* operationFixture({ timeoutMs: 100 });
    const second = yield* operationFixture();
    yield* admission.acquire(first);
    yield* TestClock.adjust(Duration.millis(100));
    yield* admission.acquire(second);
  }),
);

it.effect('Effect interruption releases scoped active permits and queued storage', () =>
  Effect.gen(function* interruptPermits() {
    const pool = createWorkPool(1, 0);
    const operation = yield* operationFixture();
    const entered = yield* Deferred.make<boolean>();
    const active = yield* Effect.forkChild(
      Effect.scoped(
        pool.acquire(operation).pipe(Effect.andThen(Deferred.succeed(entered, true)), Effect.andThen(Effect.never)),
      ),
    );
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(active);
    yield* Effect.scoped(pool.acquire(operation));
  }),
);

it.effect('wall-clock changes do not alter monotonic deadlines', () =>
  Effect.gen(function* clockDomain() {
    const operation = yield* operationFixture({ timeoutMs: 100 });
    const clock = yield* Clock.Clock;
    expect(operation.deadline).toBe(Number(clock.monotonicTimeNanosUnsafe()) / 1e6 + 100);
    yield* TestClock.adjust(Duration.millis(100));
    expect(yield* Effect.flip(operation.run(Effect.void))).toMatchObject({ kind: 'deadline' });
  }),
);

it('only explicit read-admission failures, never arbitrary status/denial, authorize replay', () => {
  for (const status of [400, 401, 409, 429, 502, 503]) {
    expect(recoverableReadAdmission(status, {})).toBe(false);
  }
  expect(recoverableReadAdmission(409, { type: 'https://ontos.dev/problems/gateway-reload-required' })).toBe(true);
  expect(
    recoverableReadAdmission(503, { retryable: true, type: 'https://ontos.dev/problems/gateway-unavailable' }),
  ).toBe(true);
  expect(recoverableReadAdmission(503, { code: 'read_handler_unavailable' })).toBe(true);
  expect(
    recoverableReadAdmission(401, { retryable: true, type: 'https://ontos.dev/problems/gateway-unavailable' }),
  ).toBe(false);
  expect(
    recoverableReadAdmission(503, { retryable: false, type: 'https://ontos.dev/problems/gateway-unavailable' }),
  ).toBe(false);
  expect(recoverableReadAdmission(503, { type: 'https://ontos.dev/problems/gateway-reload-required' })).toBe(false);
});

it.effect('browser disconnect cancels an in-progress body read and releases the reader', () =>
  Effect.gen(function* disconnectBody() {
    const caller = new AbortController();
    const operation = yield* operationFixture({ signal: caller.signal });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      start: (controller) => controller.enqueue(new Uint8Array([1])),
    });
    const reading = yield* Effect.forkChild(Effect.flip(readBytes({ body }, { maxBytes: 100, operation })));
    yield* TestClock.adjust(Duration.zero);
    caller.abort();
    expect(yield* Fiber.join(reading)).toMatchObject({ kind: 'cancelled' });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  }),
);

it.effect('the lifetime runs a failing native dispatch once and preserves its typed failure', () =>
  Effect.gen(function* dispatchOnce() {
    const operation = yield* operationFixture();
    const dispatches = yield* Ref.make(0);
    const failure = { code: 'native-denial' };
    const nativeDispatch = Ref.update(dispatches, (count) => count + 1).pipe(Effect.andThen(Effect.fail(failure)));
    expect(yield* Effect.flip(operation.run(nativeDispatch))).toBe(failure);
    expect(yield* Ref.get(dispatches)).toBe(1);
  }),
);

it.effect('invalid explicit timing and capacity configuration fails with its schema error', () =>
  Effect.gen(function* invalidConfiguration() {
    for (const timeoutMs of [-1, Infinity, Number.NaN]) {
      expect(Schema.isSchemaError(yield* Effect.flip(createOperation({ timeoutMs })))).toBe(true);
    }
    expect(Schema.isSchemaError(yield* Effect.flip(deadlineAfter(Infinity)))).toBe(true);
    const operation = yield* operationFixture();
    expect(Schema.isSchemaError(yield* Effect.flip(createAdmission(0).acquire(operation)))).toBe(true);
    expect(Schema.isSchemaError(yield* Effect.flip(Effect.scoped(createWorkPool(0).acquire(operation))))).toBe(true);
    expect(Schema.isSchemaError(yield* Effect.flip(Effect.scoped(createWorkPool(1, -1).acquire(operation))))).toBe(
      true,
    );
  }),
);

it.effect('oversized declared bodies cancel before reading and release their reader', () =>
  Effect.gen(function* rejectDeclaredBody() {
    const operation = yield* operationFixture();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
    });
    expect(
      yield* Effect.flip(
        readBytes({ body, headers: new Headers({ 'content-length': '101' }) }, { maxBytes: 100, operation }),
      ),
    ).toMatchObject({ kind: 'body_oversize' });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  }),
);

it.effect('a stalled foreign cancel hook cannot hold the deadline or retain the reader lock', () =>
  Effect.gen(function* stalledCancellation() {
    const operation = yield* operationFixture({ timeoutMs: 100 });
    const blocked = new TransformStream<Uint8Array, Uint8Array>();
    const cancellation = blocked.writable.getWriter().write(new Uint8Array([1]));
    const body = new ReadableStream<Uint8Array>({
      cancel: () => cancellation,
    });
    const reading = yield* Effect.forkChild(Effect.flip(readBytes({ body }, { maxBytes: 100, operation })));
    yield* TestClock.adjust(Duration.millis(100));
    expect(yield* Fiber.join(reading)).toMatchObject({ kind: 'deadline' });
    expect(body.locked).toBe(false);
    yield* Effect.promise(async () => {
      await blocked.readable.getReader().read();
    });
  }),
);

it.effect('native stream failure stays a body I/O failure rather than pretending the caller disconnected', () =>
  Effect.gen(function* streamFailure() {
    const operation = yield* operationFixture();
    const cause = { code: 'native-body-read-failure' };
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.error(cause) });
    const failure = yield* Effect.flip(readBytes({ body }, { maxBytes: 100, operation }));
    expect(failure).toMatchObject({ cause });
    expect(operation.signal.aborted).toBe(false);
    expect(body.locked).toBe(false);
  }),
);

it.effect('future explicit deadlines use the same branded clock domain as acquired operations', () =>
  Effect.gen(function* explicitClockDomain() {
    const deadline = yield* deadlineAfter(5000);
    const operation = yield* operationFixture({ deadline });
    expect(operation.remainingMs()).toBe(5000);
    yield* TestClock.adjust(Duration.seconds(1));
    expect(operation.remainingMs()).toBe(4000);
  }),
);

it.effect('checks the monotonic budget before every continuously readable chunk', () =>
  Effect.gen(function* readableDeadline() {
    const clock = yield* Clock.Clock;
    let ticks = 0n;
    const advancing = {
      currentTimeMillis: clock.currentTimeMillis,
      currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
      currentTimeNanos: clock.currentTimeNanos,
      currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
      monotonicTimeNanos: clock.monotonicTimeNanos,
      monotonicTimeNanosUnsafe: () => {
        ticks += 1n;
        return clock.monotonicTimeNanosUnsafe() + ticks * 1_000_000n;
      },
      sleep: (duration: Duration.Duration) => clock.sleep(duration),
    };
    const operation = yield* operationFixture({ timeoutMs: 20 }).pipe(Effect.provideService(Clock.Clock, advancing));
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          pulls += 1;
          controller.enqueue(new Uint8Array([1]));
        },
      },
      { highWaterMark: 0 },
    );
    expect(yield* Effect.flip(readBytes({ body }, { maxBytes: 100_000, operation }))).toMatchObject({
      kind: 'deadline',
    });
    expect(pulls).toBeLessThan(20);
    expect(body.locked).toBe(false);
  }),
);

for (const read of [readBytes, readJson]) {
  it.effect(`cancels an already acquired ${read.name} body before a pre-cancelled operation can pull`, () =>
    Effect.gen(function* cancelledBeforeRead() {
      const operation = yield* operationFixture();
      operation.abort('cancelled');
      let cancelled = false;
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          cancel: () => {
            cancelled = true;
          },
          pull: () => {
            pulls += 1;
          },
        },
        { highWaterMark: 0 },
      );
      const program: Effect.Effect<unknown, BodyReadFailure | OperationError | Schema.SchemaError> = read(
        { body },
        { maxBytes: 100, operation },
      );
      expect(yield* Effect.flip(program)).toMatchObject({ kind: 'cancelled' });
      expect(cancelled).toBe(true);
      expect(pulls).toBe(0);
      expect(body.locked).toBe(false);
    }),
  );
}

it.effect('reports reader acquisition failure through the typed body failure channel', () =>
  Effect.gen(function* lockedBody() {
    const operation = yield* operationFixture();
    const body = new ReadableStream<Uint8Array>();
    const lock = body.getReader();
    expect(
      Schema.is(Schema.instanceOf(BodyReadError))(
        yield* Effect.flip(readBytes({ body }, { maxBytes: 100, operation })),
      ),
    ).toBe(true);
    lock.releaseLock();
  }),
);
