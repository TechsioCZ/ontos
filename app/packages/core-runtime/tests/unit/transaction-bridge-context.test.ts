// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { Clock, Config, ConfigProvider, Context, Effect, Logger, References } from 'effect';
import { runCoreTransaction } from '../../src/db/transaction-bridge.ts';

type Executor = Parameters<typeof runCoreTransaction>[0];
type Transaction = Parameters<Parameters<typeof runCoreTransaction>[1]>[0];

// Deliberately cross an asynchronous driver boundary without providing body context.
const executor = {
  async transaction<Value>(body: (tx: Transaction) => Promise<Value>): Promise<Value> {
    await Promise.resolve();
    return await body({} as Transaction);
  },
} as Executor;

test('preserves a caller Context.Reference override instead of its default', async () => {
  const fallback = { source: 'default' };
  const override = { source: 'caller' };
  const reference = Context.Reference('bridge-context/reference', { defaultValue: () => fallback });
  assert.equal(await Effect.runPromise(reference), fallback);
  const actual = await Effect.runPromise(
    runCoreTransaction(executor, () => reference).pipe(Effect.provideService(reference, override)),
  );
  assert.equal(actual, override);
  assert.equal(await Effect.runPromise(reference), fallback);
});

test('uses caller Clock operations inside the transaction', async () => {
  let sleeps = 0;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => 1234,
    currentTimeMillis: Effect.succeed(1234),
    currentTimeNanosUnsafe: () => 1234000000n,
    currentTimeNanos: Effect.succeed(1234000000n),
    monotonicTimeNanosUnsafe: () => 5678000000n,
    monotonicTimeNanos: Effect.succeed(5678000000n),
    sleep: () =>
      Effect.sync(() => {
        sleeps++;
      }),
  };
  const actual = await Effect.runPromise(
    runCoreTransaction(executor, () =>
      Effect.gen(function* () {
        yield* Effect.sleep('1 millis');
        return yield* Clock.currentTimeMillis;
      }),
    ).pipe(Effect.provideService(Clock.Clock, clock)),
  );
  assert.equal(actual, 1234);
  assert.equal(sleeps, 1);
});

test('loads configuration from the caller provider inside the transaction', async () => {
  const provider = ConfigProvider.fromUnknown({ BRIDGE_CONTEXT_TEST_VALUE: 'caller-config' });
  const actual = await Effect.runPromise(
    runCoreTransaction(executor, () => Config.string('BRIDGE_CONTEXT_TEST_VALUE')).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, provider),
    ),
  );
  assert.equal(actual, 'caller-config');
});

test('preserves the caller span and parents transaction child spans to it', async () => {
  const actual = await Effect.runPromise(
    Effect.gen(function* () {
      const caller = yield* Effect.currentSpan;
      const inner = yield* runCoreTransaction(executor, () =>
        Effect.gen(function* () {
          const parent = yield* Effect.currentParentSpan;
          const child = yield* Effect.currentSpan.pipe(Effect.withSpan('transaction-child'));
          return { parent, child };
        }),
      );
      return { caller, ...inner };
    }).pipe(Effect.withSpan('transaction-caller')),
  );
  assert.equal(actual.parent, actual.caller);
  assert.equal(actual.child.parent._tag, 'Some');
  if (actual.child.parent._tag === 'Some') {
    assert.equal(actual.child.parent.value, actual.caller);
  }
});

test('emits transaction logs with caller annotations and logger', async () => {
  const records: Array<Readonly<Record<string, unknown>>> = [];
  const logger = Logger.make(({ fiber }) => {
    records.push(fiber.getRef(References.CurrentLogAnnotations));
  });
  await Effect.runPromise(
    runCoreTransaction(executor, () => Effect.logInfo('transaction-body')).pipe(
      Effect.annotateLogs({ requestId: 'bridge-request', operation: 'context-test' }),
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
    ),
  );
  assert.deepEqual(records, [{ requestId: 'bridge-request', operation: 'context-test' }]);
});
