// @effect-diagnostics asyncFunction:off -- Node test runner and foreign driver fixtures require Promises; expires: 2026-12-31.
import { runEffectTestPromise, runEffectTestSync } from '../support/effect-runtime.ts';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { coreRelations } from '../../src/db/schema.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Cause, Context, Deferred, Effect, Exit, Fiber, Schema } from 'effect';
import {
  CoreTransactionBridgeFailure,
  runCoreTransaction,
} from '../../src/db/transaction-bridge.ts';

type Executor = Parameters<typeof runCoreTransaction>[0];
type Transaction = Parameters<Parameters<typeof runCoreTransaction>[1]>[0];

const gate = () => {
  const deferred = Deferred.makeUnsafe<boolean>();
  return {
    promise: runEffectTestPromise(Deferred.await(deferred)),
    resolve: () => {
      runEffectTestSync(Deferred.succeed(deferred, true));
    },
  };
};

const query = async () => ({ rows: [] });

const harness = (
  options: { commit?: () => Promise<void>; rollback?: () => Promise<void> } = {},
) => {
  const events: string[] = [];
  // Drizzle supplies the actual transaction type; the fake client never opens a connection.
  const pool = new Pool();
  Object.defineProperty(pool, 'connect', { value: async () => ({ query, release: () => {} }) });
  Object.defineProperty(pool, 'query', { value: query });
  const database = drizzle({ client: pool, relations: coreRelations });
  let transaction: Transaction | undefined;
  // Model foreign settlement independently of Drizzle's query-error wrapping.
  const executor: Executor = {
    transaction: async <Value>(body: (tx: Transaction) => Promise<Value>): Promise<Value> =>
      await database.transaction(async (tx) => {
        transaction = tx;
        events.push('begin');
        let value: Value;
        try {
          value = await body(tx);
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
      }),
  };
  return {
    events,
    executor,
    get transaction() {
      return transaction;
    },
  };
};

test('preserves caller services and invokes the body once with the transaction', async () => {
  class Service extends Context.Service<Service, { readonly value: object }>()(
    '@app/core-runtime/tests/unit/transaction-bridge.test/Service',
  ) {}
  const service = { value: {} };
  const h = harness();
  let calls = 0;
  const value = await runEffectTestPromise(
    runCoreTransaction(h.executor, (tx) => {
      calls += 1;
      assert.equal(tx, h.transaction);
      return Service.pipe(Effect.map((current) => current.value));
    }).pipe(Effect.provideService(Service, service)),
  );
  assert.equal(value, service.value);
  assert.equal(calls, 1);
  assert.deepEqual(h.events, ['begin', 'commit-start', 'commit-end']);
});

test('forwards the transaction config to the driver unchanged', async () => {
  const h = harness();
  const configs: unknown[] = [];
  const executor: Executor = {
    transaction: async (body, config) => {
      configs.push(config);
      return await h.executor.transaction(body);
    },
  };
  const value = await runEffectTestPromise(
    runCoreTransaction(executor, () => Effect.succeed('committed'), {
      isolationLevel: 'repeatable read',
    }),
  );
  assert.equal(value, 'committed');
  assert.deepEqual(configs, [{ isolationLevel: 'repeatable read' }]);
});

for (const [name, cause] of [
  ['typed failure', Cause.fail({ _tag: 'ExpectedFailure', identity: {} })],
  ['defect', Cause.die(new Error('body defect'))],
] as const) {
  test(`${name} rolls back with its original cause unchanged`, async () => {
    const h = harness();
    const exit = await runEffectTestPromise(
      Effect.exit(runCoreTransaction(h.executor, () => Effect.failCause(cause))),
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
    const result = runEffectTestPromise(
      Effect.exit(runCoreTransaction(h.executor, () => Effect.failCause(cause))),
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
        Cause.combine(
          cause,
          Cause.fail(new CoreTransactionBridgeFailure({ original: rejection, outcome: 'unknown' })),
        ),
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
    commit: async () => {
      throw commitRejection;
    },
    rollback: async () => {
      rollingBack.resolve();
      await releaseRollback.promise;
      throw rollbackRejection;
    },
  });
  let calls = 0;
  const program = runCoreTransaction(h.executor, () => {
    calls += 1;
    return calls === 1 ? Effect.failCause(cause) : Effect.succeed(42);
  });
  const first = runEffectTestPromise(Effect.exit(program));
  try {
    await rollingBack.promise;
    const second = await runEffectTestPromise(Effect.exit(program));
    assert.ok(Exit.isFailure(second));
    assert.deepEqual(
      second.cause,
      Cause.fail(
        new CoreTransactionBridgeFailure({ original: commitRejection, outcome: 'unknown' }),
      ),
    );
    releaseRollback.resolve();
    const exit = await first;
    assert.ok(Exit.isFailure(exit));
    assert.deepEqual(
      exit.cause,
      Cause.combine(
        cause,
        Cause.fail(
          new CoreTransactionBridgeFailure({ original: rollbackRejection, outcome: 'unknown' }),
        ),
      ),
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
  const exit = await runEffectTestPromise(
    Effect.exit(
      runCoreTransaction(h.executor, (): Effect.Effect<never> => {
        throw defect;
      }),
    ),
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
  const failure = await runEffectTestPromise(
    Effect.flip(runCoreTransaction(h.executor, () => Effect.succeed(42))),
  );
  assert.ok(Schema.is(CoreTransactionBridgeFailure)(failure));
  assert.equal(failure.outcome, 'unknown');
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
    let settled = false;
    const fiber = runEffectTestSync(
      Effect.forkDetach(
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
      ),
    );
    const result = runEffectTestPromise(Fiber.await(fiber)).then((exit) => {
      settled = true;
      return exit;
    });
    try {
      await started.promise;
      fiber.interruptUnsafe();
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
      assert.deepEqual(
        exit.cause.reasons.map((reason) => reason._tag),
        ['Interrupt'],
      );
      assert.deepEqual(h.events, ['begin', 'finalized', 'rollback-start', 'rollback-end']);
    } finally {
      fiber.interruptUnsafe();
      releaseFinalizer.resolve();
      releaseRollback.resolve();
      await result;
    }
  },
);

test(
  'interruption during commit waits for driver settlement and reports committed outcome',
  { timeout: 2000 },
  async () => {
    const committing = gate();
    const releaseCommit = gate();
    const h = harness({
      commit: async () => {
        committing.resolve();
        await releaseCommit.promise;
      },
    });
    let settled = false;
    const fiber = runEffectTestSync(
      Effect.forkDetach(runCoreTransaction(h.executor, () => Effect.succeed(42))),
    );
    const result = runEffectTestPromise(Fiber.await(fiber)).then((exit) => {
      settled = true;
      return exit;
    });
    try {
      await committing.promise;
      fiber.interruptUnsafe();
      await runEffectTestPromise(Effect.yieldNow);
      assert.equal(settled, false);
      releaseCommit.resolve();
      const exit = await result;
      assert.ok(Exit.isFailure(exit));
      assert.deepEqual(
        exit.cause.reasons.map((reason) => reason._tag),
        ['Interrupt', 'Fail'],
      );
      const [, failure] = exit.cause.reasons;
      assert.ok(failure !== undefined && Cause.isFailReason(failure));
      assert.ok(Schema.is(CoreTransactionBridgeFailure)(failure.error));
      assert.equal(failure.error.outcome, 'committed');
      assert.equal(failure.error.original, undefined);
      assert.deepEqual(h.events, ['begin', 'commit-start', 'commit-end']);
    } finally {
      releaseCommit.resolve();
      await result;
    }
  },
);

test(
  'interruption during rollback retains the original body defect',
  { timeout: 2000 },
  async () => {
    const defect = new Error('body defect before interruption');
    const rollingBack = gate();
    const releaseRollback = gate();
    const h = harness({
      rollback: async () => {
        rollingBack.resolve();
        await releaseRollback.promise;
      },
    });
    let settled = false;
    const fiber = runEffectTestSync(
      Effect.forkDetach(runCoreTransaction(h.executor, () => Effect.die(defect))),
    );
    const result = runEffectTestPromise(Fiber.await(fiber)).then((exit) => {
      settled = true;
      return exit;
    });
    try {
      await rollingBack.promise;
      fiber.interruptUnsafe();
      await runEffectTestPromise(Effect.yieldNow);
      assert.equal(settled, false);
      assert.deepEqual(h.events, ['begin', 'rollback-start']);
      releaseRollback.resolve();
      const exit = await result;
      assert.ok(Exit.isFailure(exit));
      assert.deepEqual(
        exit.cause.reasons.map((reason) => reason._tag),
        ['Interrupt', 'Die'],
      );
      const [, bodyDefect] = exit.cause.reasons;
      assert.ok(bodyDefect !== undefined && Cause.isDieReason(bodyDefect));
      assert.equal(bodyDefect.defect, defect);
      assert.deepEqual(h.events, ['begin', 'rollback-start', 'rollback-end']);
    } finally {
      fiber.interruptUnsafe();
      releaseRollback.resolve();
      await result;
    }
  },
);

for (const phase of ['commit', 'rollback'] as const) {
  test(
    `interruption during ${phase} surfaces a later driver rejection as bridge failure`,
    { timeout: 2000 },
    async () => {
      const settling = gate();
      const releaseSettlement = gate();
      const rejection = new Error(`${phase} rejected after interruption`);
      const h = harness({
        [phase]: async () => {
          settling.resolve();
          await releaseSettlement.promise;
          throw rejection;
        },
      });
      let settled = false;
      const fiber = runEffectTestSync(
        Effect.forkDetach(
          runCoreTransaction(h.executor, () =>
            phase === 'commit' ? Effect.succeed(42) : Effect.fail('body failed'),
          ),
        ),
      );
      const result = runEffectTestPromise(Fiber.await(fiber)).then((exit) => {
        settled = true;
        return exit;
      });
      try {
        await settling.promise;
        fiber.interruptUnsafe();
        await runEffectTestPromise(Effect.yieldNow);
        assert.equal(settled, false);
        assert.deepEqual(h.events, ['begin', `${phase}-start`]);
        releaseSettlement.resolve();
        const exit = await result;
        assert.ok(Exit.isFailure(exit));
        assert.deepEqual(
          exit.cause.reasons.map((reason) => reason._tag),
          phase === 'commit' ? ['Interrupt', 'Fail'] : ['Interrupt', 'Fail', 'Fail'],
        );
        if (phase === 'rollback') {
          const [, bodyFailure] = exit.cause.reasons;
          assert.ok(bodyFailure !== undefined && Cause.isFailReason(bodyFailure));
          assert.equal(bodyFailure.error, 'body failed');
        }
        const failure = exit.cause.reasons.at(-1);
        assert.ok(failure !== undefined && Cause.isFailReason(failure));
        assert.ok(Schema.is(CoreTransactionBridgeFailure)(failure.error));
        assert.equal(failure.error.outcome, 'unknown');
        assert.equal(failure.error.original, rejection);
        assert.deepEqual(h.events, ['begin', `${phase}-start`]);
      } finally {
        fiber.interruptUnsafe();
        releaseSettlement.resolve();
        await result;
      }
    },
  );
}
