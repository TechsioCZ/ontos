// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { Cause, Context, Deferred, Effect, Exit } from 'effect';
import {
  CoreTransactionBridgeFailure,
  runCoreTransaction,
} from '../../src/db/transaction-bridge.ts';

type Executor = Parameters<typeof runCoreTransaction>[0];
type Transaction = Parameters<Parameters<typeof runCoreTransaction>[1]>[0];

const gate = () => {
  const deferred = Deferred.makeUnsafe<void>();
  return {
    promise: Effect.runPromise(Deferred.await(deferred)),
    resolve: () => {
      Effect.runSync(Deferred.succeed(deferred, undefined));
    },
  };
};

const harness = (
  options: { commit?: () => Promise<void>; rollback?: () => Promise<void> } = {},
) => {
  const events: string[] = [];
  const transaction = {} as Transaction;
  const executor = {
    async transaction<Value>(body: (tx: Transaction) => Promise<Value>): Promise<Value> {
      events.push('begin');
      let value: Value;
      try {
        value = await body(transaction);
      } catch (error) {
        events.push('rollback-start');
        await options.rollback?.();
        events.push('rollback-end');
        throw error;
      }
      events.push('commit-start');
      await options.commit?.();
      events.push('commit-end');
      return value;
    },
  } as Executor;
  return { executor, transaction, events };
};

test('preserves caller services and invokes the body once with the transaction', async () => {
  class Service extends Context.Service<Service, { readonly value: object }>()(
    '@app/core-runtime/tests/unit/transaction-bridge.test/Service',
  ) {}
  const service = { value: {} };
  const h = harness();
  let calls = 0;
  const value = await Effect.runPromise(
    runCoreTransaction(h.executor, (tx) => {
      calls++;
      assert.equal(tx, h.transaction);
      return Effect.map(Service, (current) => current.value);
    }).pipe(Effect.provideService(Service, service)),
  );
  assert.equal(value, service.value);
  assert.equal(calls, 1);
  assert.deepEqual(h.events, ['begin', 'commit-start', 'commit-end']);
});

for (const [name, cause] of [
  ['typed failure', Cause.fail({ _tag: 'ExpectedFailure', identity: {} })],
  ['defect', Cause.die(new Error('body defect'))],
] as const) {
  test(`${name} rolls back with its original cause unchanged`, async () => {
    const h = harness();
    const exit = await Effect.runPromiseExit(
      runCoreTransaction(h.executor, () => Effect.failCause(cause)),
    );
    assert.ok(Exit.isFailure(exit));
    assert.equal(exit.cause, cause);
    assert.deepEqual(h.events, ['begin', 'rollback-start', 'rollback-end']);
  });
}

test(
  'rollback rejection retains the mixed body cause and waits for driver settlement',
  { timeout: 2000 },
  async () => {
    const domainFailure = { _tag: 'ExpectedFailure', identity: {} };
    const defect = new Error('body defect');
    const cause = Cause.combine(Cause.fail(domainFailure), Cause.die(defect));
    const rejection = new Error('rollback rejected');
    const rollingBack = gate();
    const releaseRollback = gate();
    // Like Drizzle, the foreign wrapper awaits ROLLBACK before rethrowing the
    // body's sentinel, so a physical rollback rejection replaces that sentinel.
    const h = harness({
      rollback: async () => {
        rollingBack.resolve();
        await releaseRollback.promise;
        throw rejection;
      },
    });
    let settled = false;
    const result = Effect.runPromiseExit(
      runCoreTransaction(h.executor, () => Effect.failCause(cause)),
    ).then((exit) => {
      settled = true;
      return exit;
    });
    try {
      await rollingBack.promise;
      assert.equal(settled, false);
      assert.deepEqual(h.events, ['begin', 'rollback-start']);
      releaseRollback.resolve();
      const exit = await result;
      assert.ok(Exit.isFailure(exit));
      assert.deepEqual(
        exit.cause,
        Cause.combine(cause, Cause.fail(new CoreTransactionBridgeFailure(rejection))),
      );
      assert.equal(exit.cause.reasons[0], cause.reasons[0]);
      assert.equal(exit.cause.reasons[1], cause.reasons[1]);
      assert.deepEqual(h.events, ['begin', 'rollback-start']);
    } finally {
      releaseRollback.resolve();
      await result;
    }
  },
);

test('concurrent runs do not share a failed body Exit', { timeout: 2000 }, async () => {
  const cause = Cause.fail({ _tag: 'ExpectedFailure' });
  const rollbackRejection = new Error('rollback rejected');
  const commitRejection = new Error('commit rejected');
  const rollingBack = gate();
  const releaseRollback = gate();
  const h = harness({
    rollback: async () => {
      rollingBack.resolve();
      await releaseRollback.promise;
      throw rollbackRejection;
    },
    commit: async () => {
      throw commitRejection;
    },
  });
  let calls = 0;
  const program = runCoreTransaction(h.executor, () =>
    ++calls === 1 ? Effect.failCause(cause) : Effect.succeed(42),
  );
  const first = Effect.runPromiseExit(program);
  try {
    await rollingBack.promise;
    const second = await Effect.runPromiseExit(program);
    assert.ok(Exit.isFailure(second));
    assert.deepEqual(second.cause, Cause.fail(new CoreTransactionBridgeFailure(commitRejection)));
    releaseRollback.resolve();
    const exit = await first;
    assert.ok(Exit.isFailure(exit));
    assert.deepEqual(
      exit.cause,
      Cause.combine(cause, Cause.fail(new CoreTransactionBridgeFailure(rollbackRejection))),
    );
    assert.equal(calls, 2);
  } finally {
    releaseRollback.resolve();
    await first;
  }
});

test('a synchronous body construction throw remains a defect and rolls back', async () => {
  const h = harness();
  const defect = new Error('construction defect');
  const exit = await Effect.runPromiseExit(
    runCoreTransaction(h.executor, (): Effect.Effect<never> => {
      throw defect;
    }),
  );
  assert.ok(Exit.isFailure(exit));
  assert.deepEqual(exit.cause, Cause.die(defect));
  assert.deepEqual(h.events, ['begin', 'rollback-start', 'rollback-end']);
});

test('commit rejection cannot report the body value as success', async () => {
  const rejection = new Error('commit rejected');
  const h = harness({
    commit: async () => {
      throw rejection;
    },
  });
  const failure = await Effect.runPromise(
    Effect.flip(runCoreTransaction(h.executor, () => Effect.succeed(42))),
  );
  assert.ok(failure instanceof CoreTransactionBridgeFailure);
  assert.equal(failure.original, rejection);
  assert.deepEqual(h.events, ['begin', 'commit-start']);
});

test(
  'interruption waits for body finalizers and driver rollback settlement',
  { timeout: 2000 },
  async () => {
    const started = gate();
    const finalizing = gate();
    const releaseFinalizer = gate();
    const rollingBack = gate();
    const releaseRollback = gate();
    const h = harness({
      rollback: async () => {
        rollingBack.resolve();
        await releaseRollback.promise;
      },
    });
    const controller = new AbortController();
    let settled = false;
    const result = Effect.runPromiseExit(
      runCoreTransaction(h.executor, () =>
        Effect.ensuring(
          Effect.andThen(Effect.sync(started.resolve), Effect.never),
          Effect.promise(async () => {
            finalizing.resolve();
            await releaseFinalizer.promise;
            h.events.push('finalized');
          }),
        ),
      ),
      { signal: controller.signal },
    ).then((exit) => {
      settled = true;
      return exit;
    });
    try {
      await started.promise;
      controller.abort();
      await finalizing.promise;
      assert.equal(settled, false);
      assert.deepEqual(h.events, ['begin']);
      releaseFinalizer.resolve();
      await rollingBack.promise;
      assert.equal(settled, false);
      assert.deepEqual(h.events, ['begin', 'finalized', 'rollback-start']);
      releaseRollback.resolve();
      const exit = await result;
      assert.ok(Exit.isFailure(exit));
      assert.ok(Cause.hasInterrupts(exit.cause));
      assert.deepEqual(h.events, ['begin', 'finalized', 'rollback-start', 'rollback-end']);
    } finally {
      controller.abort();
      releaseFinalizer.resolve();
      releaseRollback.resolve();
      await result;
    }
  },
);

test('interruption during commit waits for driver settlement', { timeout: 2000 }, async () => {
  const committing = gate();
  const releaseCommit = gate();
  const h = harness({
    commit: async () => {
      committing.resolve();
      await releaseCommit.promise;
    },
  });
  const controller = new AbortController();
  let settled = false;
  const result = Effect.runPromiseExit(
    runCoreTransaction(h.executor, () => Effect.succeed(42)),
    { signal: controller.signal },
  ).then((exit) => {
    settled = true;
    return exit;
  });
  try {
    await committing.promise;
    controller.abort();
    await Effect.runPromise(Effect.yieldNow);
    assert.equal(settled, false);
    releaseCommit.resolve();
    const exit = await result;
    assert.ok(Exit.isFailure(exit));
    assert.ok(Cause.hasInterrupts(exit.cause));
    assert.deepEqual(h.events, ['begin', 'commit-start', 'commit-end']);
  } finally {
    releaseCommit.resolve();
    await result;
  }
});
