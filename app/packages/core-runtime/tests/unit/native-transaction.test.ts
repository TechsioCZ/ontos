// @effect-diagnostics asyncFunction:off -- Node's test callback is the Effect execution boundary; expires: 2026-12-31.
import { sql } from 'drizzle-orm';
import { Cause, Context, Deferred, Effect, Exit, Fiber } from 'effect';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeTestDatabase } from '../support/database.ts';
import { runEffectTestPromise } from '../support/effect-runtime.ts';

const harness = (
  settle: (statement: string) => Effect.Effect<void, SqlError> = () => Effect.void,
) => {
  const events: string[] = [];
  const executor = makeTestDatabase((statement) =>
    Effect.gen(function* execute() {
      events.push(statement);
      yield* settle(statement);
      return [];
    }),
  );
  return { events, executor };
};

test('native transactions preserve caller services and execute the body once', async () => {
  class Service extends Context.Service<Service, { readonly value: object }>()(
    '@app/core-runtime/tests/unit/native-transaction.test/Service',
  ) {}
  const service = { value: {} };
  const h = harness();
  let calls = 0;
  const value = await runEffectTestPromise(
    h.executor
      .transaction(() => {
        calls += 1;
        return Service.pipe(Effect.map((current) => current.value));
      })
      .pipe(Effect.provideService(Service, service)),
  );
  assert.equal(value, service.value);
  assert.equal(calls, 1);
  assert.deepEqual(h.events, ['BEGIN', 'COMMIT']);
});

test('native isolation configuration precedes transaction queries', async () => {
  const h = harness();
  await runEffectTestPromise(
    h.executor.transaction((transaction) =>
      Effect.gen(function* snapshot() {
        yield* transaction.setTransaction({
          accessMode: 'read only',
          isolationLevel: 'repeatable read',
        });
        yield* transaction.execute(sql`select 1`, 'objects');
      }),
    ),
  );
  assert.deepEqual(h.events, [
    'BEGIN',
    'set transaction isolation level repeatable read read only',
    'select 1',
    'COMMIT',
  ]);
});

for (const [name, cause] of [
  ['typed failure', Cause.fail({ _tag: 'ExpectedFailure', identity: {} })],
  ['defect', Cause.die(new Error('body defect'))],
] as const) {
  test(`native ${name} rolls back with the original cause`, async () => {
    const h = harness();
    const exit = await runEffectTestPromise(
      Effect.exit(h.executor.transaction(() => Effect.failCause(cause))),
    );
    assert.ok(Exit.isFailure(exit));
    assert.deepEqual(exit.cause, cause);
    assert.deepEqual(h.events, ['BEGIN', 'ROLLBACK']);
  });
}

test('a synchronous body construction throw rolls back', async () => {
  const h = harness();
  const defect = new Error('construction defect');
  const exit = await runEffectTestPromise(
    Effect.exit(
      h.executor.transaction((): Effect.Effect<never> => {
        throw defect;
      }),
    ),
  );
  assert.ok(Exit.isFailure(exit));
  assert.deepEqual(exit.cause, Cause.die(defect));
  assert.deepEqual(h.events, ['BEGIN', 'ROLLBACK']);
});

for (const phase of ['COMMIT', 'ROLLBACK']) {
  test(`native ${phase} failure surfaces the SQL defect`, async () => {
    const failure = new SqlError({
      reason: new ConnectionError({ cause: new Error(`${phase} failed`) }),
    });
    const h = harness((statement) => (statement === phase ? Effect.fail(failure) : Effect.void));
    const exit = await runEffectTestPromise(
      Effect.exit(
        h.executor.transaction(() =>
          phase === 'COMMIT' ? Effect.succeed(42) : Effect.fail('body failure'),
        ),
      ),
    );
    assert.ok(Exit.isFailure(exit));
    assert.ok(
      exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === failure),
    );
    assert.deepEqual(h.events, ['BEGIN', phase]);
  });
}

test(
  'interruption waits for body finalizers and native rollback settlement',
  { timeout: 2000 },
  async () => {
    const result = await runEffectTestPromise(
      Effect.gen(function* interruptTransaction() {
        const started = yield* Deferred.make<null>();
        const finalizing = yield* Deferred.make<null>();
        const releaseFinalizer = yield* Deferred.make<null>();
        const rollingBack = yield* Deferred.make<null>();
        const releaseRollback = yield* Deferred.make<null>();
        const h = harness((statement) =>
          statement === 'ROLLBACK'
            ? Deferred.succeed(rollingBack, null).pipe(
                Effect.andThen(Deferred.await(releaseRollback)),
              )
            : Effect.void,
        );
        const fiber = yield* h.executor
          .transaction(() =>
            Deferred.succeed(started, null).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Deferred.succeed(finalizing, null).pipe(
                  Effect.andThen(Deferred.await(releaseFinalizer)),
                ),
              ),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const interrupt = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
        yield* Deferred.await(finalizing);
        assert.equal(fiber.pollUnsafe(), undefined);
        assert.deepEqual(h.events, ['BEGIN']);
        yield* Deferred.succeed(releaseFinalizer, null);
        yield* Deferred.await(rollingBack);
        assert.equal(fiber.pollUnsafe(), undefined);
        yield* Deferred.succeed(releaseRollback, null);
        yield* Fiber.join(interrupt);
        return { events: h.events, exit: yield* Fiber.await(fiber) };
      }),
    );
    assert.ok(Exit.isFailure(result.exit));
    assert.equal(Cause.hasInterrupts(result.exit.cause), true);
    assert.deepEqual(result.events, ['BEGIN', 'ROLLBACK']);
  },
);

for (const phase of ['COMMIT', 'ROLLBACK']) {
  test(
    `interruption waits for native ${phase} and preserves a later SQL failure`,
    { timeout: 2000 },
    async () => {
      const failure = new SqlError({
        reason: new ConnectionError({ cause: new Error(`${phase} rejected`) }),
      });
      const exit = await runEffectTestPromise(
        Effect.gen(function* interruptSettlement() {
          const started = yield* Deferred.make<null>();
          const release = yield* Deferred.make<null>();
          const h = harness((statement) =>
            statement === phase
              ? Deferred.succeed(started, null).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Effect.fail(failure)),
                )
              : Effect.void,
          );
          const fiber = yield* h.executor
            .transaction(() =>
              phase === 'COMMIT' ? Effect.succeed(42) : Effect.fail('domain failure'),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const interrupt = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          assert.equal(fiber.pollUnsafe(), undefined);
          yield* Deferred.succeed(release, null);
          yield* Fiber.join(interrupt);
          return yield* Fiber.await(fiber);
        }),
      );
      assert.ok(Exit.isFailure(exit));
      // Native settlement defects take precedence over pending interruption.
      assert.ok(
        exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === failure),
      );
    },
  );
}
