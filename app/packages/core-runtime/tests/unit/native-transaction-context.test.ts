import assert from 'node:assert/strict';
import test from 'node:test';

// @effect-diagnostics asyncFunction:off -- Node test runner and foreign driver fixtures require Promises; expires: 2026-12-31.
import {
  Clock,
  Config,
  ConfigProvider,
  Context,
  Effect,
  Logger,
  Option,
  References,
} from 'effect';
import { TestClock } from 'effect/testing';

import { makeTestDatabase } from '../support/database.ts';
import { runEffectTestPromise } from '../support/effect-runtime.ts';

const executor = makeTestDatabase(() => Effect.succeed([]));

test('preserves a caller Context.Reference override instead of its default', async () => {
  const fallback = { source: 'default' };
  const override = { source: 'caller' };
  const reference = Context.Reference('native-transaction-context/reference', {
    defaultValue: () => fallback,
  });
  assert.equal(await runEffectTestPromise(reference), fallback);
  const actual = await runEffectTestPromise(
    executor
      .transaction(() => reference)
      .pipe(Effect.provideService(reference, override))
  );
  assert.equal(actual, override);
  assert.equal(await runEffectTestPromise(reference), fallback);
});

test('uses caller Clock operations inside the transaction', async () => {
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
  const actual = await runEffectTestPromise(
    executor
      .transaction(() =>
        Effect.gen(function* callerProgram() {
          yield* Effect.sleep('1 millis');
          return yield* Clock.currentTimeMillis;
        })
      )
      .pipe(Effect.provideService(Clock.Clock, clock))
  );
  assert.equal(actual, 1234);
  assert.equal(sleeps, 1);
});

test('preserves a caller TestClock inside the transaction', async () => {
  const actual = await runEffectTestPromise(
    Effect.gen(function* virtualClockProgram() {
      const clock = yield* TestClock.make();
      yield* clock.setTime(1234);
      return yield* executor
        .transaction(() => Clock.currentTimeMillis)
        .pipe(Effect.provideService(Clock.Clock, clock));
    }).pipe(Effect.scoped)
  );
  assert.equal(actual, 1234);
});

test('loads configuration from the caller provider inside the transaction', async () => {
  const provider = ConfigProvider.fromUnknown({
    NATIVE_CONTEXT_TEST_VALUE: 'caller-config',
  });
  const actual = await runEffectTestPromise(
    executor
      .transaction(() => Config.string('NATIVE_CONTEXT_TEST_VALUE'))
      .pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
  );
  assert.equal(actual, 'caller-config');
});

test('preserves the caller span and parents transaction child spans to it', async () => {
  const actual = await runEffectTestPromise(
    Effect.gen(function* callerProgram() {
      const caller = yield* Effect.currentSpan;
      const inner = yield* executor.transaction(() =>
        Effect.gen(function* transactionProgram() {
          const parent = yield* Effect.currentParentSpan;
          const child = yield* Effect.currentSpan.pipe(
            Effect.withSpan('transaction-child')
          );
          return { child, parent };
        })
      );
      return { caller, ...inner };
    }).pipe(Effect.withSpan('transaction-caller'))
  );
  assert.ok('name' in actual.parent);
  assert.equal(actual.parent.name, 'sql.transaction');
  assert.ok(Option.isSome(actual.parent.parent));
  assert.equal(actual.parent.parent.value, actual.caller);
  assert.ok(Option.isSome(actual.child.parent));
  assert.equal(actual.child.parent.value, actual.parent);
});

test('emits transaction logs with caller annotations and logger', async () => {
  const records: Effect.Success<typeof References.CurrentLogAnnotations>[] = [];
  const logger = Logger.make(({ fiber }) => {
    records.push(fiber.getRef(References.CurrentLogAnnotations));
  });
  await runEffectTestPromise(
    executor
      .transaction(() => Effect.logInfo('transaction-body'))
      .pipe(
        Effect.annotateLogs({
          operation: 'context-test',
          requestId: 'native-request',
        }),
        Effect.provideService(Logger.CurrentLoggers, new Set([logger]))
      )
  );
  assert.deepEqual(records, [
    { operation: 'context-test', requestId: 'native-request' },
  ]);
});
