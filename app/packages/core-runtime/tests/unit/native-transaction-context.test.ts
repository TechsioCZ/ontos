import { Clock, Config, ConfigProvider, Context, Effect, Layer, Logger, Option, References, Tracer } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { makeTestDatabase } from '../support/database.ts';

it.effect('preserves a caller Context.Reference override instead of its default', () =>
  Effect.gen(function* preserveReference() {
    const executor = yield* makeTestDatabase(() => Effect.succeed([]));
    const fallback = { source: 'default' };
    const override = { source: 'caller' };
    const reference = Context.Reference('native-transaction-context/reference', {
      defaultValue: () => fallback,
    });
    expect(yield* reference).toBe(fallback);
    const actual = yield* executor.transaction(() => reference).pipe(Effect.provideService(reference, override));
    expect(actual).toBe(override);
    expect(yield* reference).toBe(fallback);
  }),
);

it.effect('uses caller Clock operations inside the transaction', () =>
  Effect.gen(function* preserveClock() {
    const executor = yield* makeTestDatabase(() => Effect.succeed([]));
    let sleeps = 0;
    const clock: Clock.Clock = {
      currentTimeMillis: Effect.succeed(1234),
      currentTimeMillisUnsafe: () => 1234,
      currentTimeNanos: Effect.succeed(1_234_000_000n),
      currentTimeNanosUnsafe: () => 1_234_000_000n,
      monotonicTimeNanos: Effect.succeed(5_678_000_000n),
      monotonicTimeNanosUnsafe: () => 5_678_000_000n,
      sleep: () =>
        Effect.sync(() => {
          sleeps += 1;
        }),
    };
    const actual = yield* executor
      .transaction(() =>
        Effect.gen(function* callerProgram() {
          yield* Effect.sleep('1 millis');
          return yield* Clock.currentTimeMillis;
        }),
      )
      .pipe(Effect.provideService(Clock.Clock, clock));
    expect(actual).toBe(1234);
    expect(sleeps).toBe(1);
  }),
);

it.effect('preserves a caller TestClock inside the transaction', () =>
  Effect.gen(function* preserveTestClock() {
    const executor = yield* makeTestDatabase(() => Effect.succeed([]));
    const actual = yield* Effect.gen(function* virtualClockProgram() {
      const clock = yield* TestClock.make();
      yield* clock.setTime(1234);
      return yield* executor.transaction(() => Clock.currentTimeMillis).pipe(Effect.provideService(Clock.Clock, clock));
    }).pipe(Effect.scoped);
    expect(actual).toBe(1234);
  }),
);

it.effect('loads configuration from the caller provider inside the transaction', () =>
  Effect.gen(function* preserveConfig() {
    const executor = yield* makeTestDatabase(() => Effect.succeed([]));
    const provider = ConfigProvider.fromUnknown({
      NATIVE_CONTEXT_TEST_VALUE: 'caller-config',
    });
    const actual = yield* executor
      .transaction(() => Config.string('NATIVE_CONTEXT_TEST_VALUE'))
      .pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider));
    expect(actual).toBe('caller-config');
  }),
);

const spanPreservation = Effect.gen(function* preserveSpans() {
  const executor = yield* makeTestDatabase(() => Effect.succeed([]));
  const actual = yield* Effect.gen(function* callerProgram() {
    const caller = yield* Effect.currentSpan;
    const inner = yield* executor.transaction(() =>
      Effect.gen(function* transactionProgram() {
        const parent = yield* Effect.currentParentSpan;
        const child = yield* Effect.currentSpan.pipe(Effect.withSpan('transaction-child'));
        return { child, parent };
      }),
    );
    return { caller, ...inner };
  }).pipe(Effect.withSpan('transaction-caller'));
  expect('name' in actual.parent).toBe(true);
  if (!('name' in actual.parent)) {
    throw new Error('Expected assertion to hold');
  }
  expect(actual.parent.name).toBe('sql.transaction');
  expect(Option.isSome(actual.parent.parent)).toBe(true);
  if (!Option.isSome(actual.parent.parent)) {
    throw new Error('Expected assertion to hold');
  }
  expect(actual.parent.parent.value).toBe(actual.caller);
  expect(Option.isSome(actual.child.parent)).toBe(true);
  if (!Option.isSome(actual.child.parent)) {
    throw new Error('Expected assertion to hold');
  }
  expect(actual.child.parent.value).toBe(actual.parent);
});

it.layer(Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })))(
  'native transaction tracing',
  (tracingIt) => {
    tracingIt.effect('preserves the caller span and parents transaction child spans to it', () => spanPreservation);
  },
);

it.effect('emits transaction logs with caller annotations and logger', () =>
  Effect.gen(function* preserveLogging() {
    const executor = yield* makeTestDatabase(() => Effect.succeed([]));
    const records: Effect.Success<typeof References.CurrentLogAnnotations>[] = [];
    const logger = Logger.make(({ fiber }) => {
      records.push(fiber.getRef(References.CurrentLogAnnotations));
    });
    yield* executor
      .transaction(() => Effect.logInfo('transaction-body'))
      .pipe(
        Effect.annotateLogs({
          operation: 'context-test',
          requestId: 'native-request',
        }),
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      );
    expect(records).toEqual([{ operation: 'context-test', requestId: 'native-request' }]);
  }),
);
