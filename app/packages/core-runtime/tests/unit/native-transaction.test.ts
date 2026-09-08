import { expect, it } from '@app/effect-rstest';
import { sql } from 'drizzle-orm';
import { Cause, Context, Deferred, Effect, Exit, Fiber } from 'effect';
import { ConnectionError, SqlError } from 'effect/unstable/sql/SqlError';
import { makeTestDatabase } from '../support/database.ts';

const harness = Effect.fn(function* makeHarness(
  settle: (statement: string) => Effect.Effect<void, SqlError> = () => Effect.void,
) {
  const events: string[] = [];
  const executor = yield* makeTestDatabase((statement) =>
    Effect.gen(function* execute() {
      events.push(statement);
      yield* settle(statement);
      return [];
    }),
  );
  return { events, executor };
});

it.effect('native transactions preserve caller services and execute the body once', () =>
  Effect.gen(function* preserveCallerServices() {
    class Service extends Context.Service<Service, { readonly value: object }>()(
      '@app/core-runtime/tests/unit/native-transaction.test/Service',
    ) {}
    const service = { value: {} };
    const h = yield* harness();
    let calls = 0;
    const value = yield* h.executor
      .transaction(() => {
        calls += 1;
        return Service.pipe(Effect.map((current) => current.value));
      })
      .pipe(Effect.provideService(Service, service));
    expect(value).toBe(service.value);
    expect(calls).toBe(1);
    expect(h.events).toEqual(['BEGIN', 'COMMIT']);
  }),
);

it.effect('native isolation configuration precedes transaction queries', () =>
  Effect.gen(function* configureIsolation() {
    const h = yield* harness();
    yield* h.executor.transaction((transaction) =>
      Effect.gen(function* snapshot() {
        yield* transaction.setTransaction({
          accessMode: 'read only',
          isolationLevel: 'repeatable read',
        });
        yield* transaction.execute(sql`select 1`, 'objects');
      }),
    );
    expect(h.events).toEqual([
      'BEGIN',
      'set transaction isolation level repeatable read read only',
      'select 1',
      'COMMIT',
    ]);
  }),
);

for (const [name, cause] of [
  ['typed failure', Cause.fail({ _tag: 'ExpectedFailure', identity: {} })],
  ['defect', Cause.die(new Error('body defect'))],
] as const) {
  it.effect(`native ${name} rolls back with the original cause`, () =>
    Effect.gen(function* rollbackOriginalCause() {
      const h = yield* harness();
      const exit = yield* Effect.exit(h.executor.transaction(() => Effect.failCause(cause)));
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) {
        throw new Error('Expected assertion to hold');
      }
      expect(exit.cause).toEqual(cause);
      expect(h.events).toEqual(['BEGIN', 'ROLLBACK']);
    }),
  );
}

it.effect('a synchronous body construction throw rolls back', () =>
  Effect.gen(function* rollbackConstructionThrow() {
    const h = yield* harness();
    const defect = new Error('construction defect');
    const exit = yield* Effect.exit(
      h.executor.transaction((): Effect.Effect<never> => {
        throw defect;
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) {
      throw new Error('Expected assertion to hold');
    }
    expect(exit.cause).toEqual(Cause.die(defect));
    expect(h.events).toEqual(['BEGIN', 'ROLLBACK']);
  }),
);

for (const phase of ['COMMIT', 'ROLLBACK']) {
  it.effect(`native ${phase} failure surfaces the SQL defect`, () =>
    Effect.gen(function* surfaceSettlementFailure() {
      const failure = new SqlError({
        reason: new ConnectionError({ cause: new Error(`${phase} failed`) }),
      });
      const h = yield* harness((statement) =>
        statement === phase ? Effect.fail(failure) : Effect.void,
      );
      const exit = yield* Effect.exit(
        h.executor.transaction(() =>
          phase === 'COMMIT' ? Effect.succeed(42) : Effect.fail('body failure'),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) {
        throw new Error('Expected assertion to hold');
      }
      expect(
        exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === failure),
      ).toBe(true);
      expect(h.events).toEqual(['BEGIN', phase]);
    }),
  );
}

it.effect(
  'interruption waits for body finalizers and native rollback settlement',
  () =>
    Effect.gen(function* waitForRollback() {
      const started = yield* Deferred.make<null>();
      const finalizing = yield* Deferred.make<null>();
      const releaseFinalizer = yield* Deferred.make<null>();
      const rollingBack = yield* Deferred.make<null>();
      const releaseRollback = yield* Deferred.make<null>();
      const h = yield* harness((statement) =>
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
      expect(fiber.pollUnsafe()).toBe(undefined);
      expect(h.events).toEqual(['BEGIN']);
      yield* Deferred.succeed(releaseFinalizer, null);
      yield* Deferred.await(rollingBack);
      expect(fiber.pollUnsafe()).toBe(undefined);
      yield* Deferred.succeed(releaseRollback, null);
      yield* Fiber.join(interrupt);
      const result = { events: h.events, exit: yield* Fiber.await(fiber) };
      expect(Exit.isFailure(result.exit)).toBe(true);
      if (!Exit.isFailure(result.exit)) {
        throw new Error('Expected assertion to hold');
      }
      expect(Cause.hasInterrupts(result.exit.cause)).toBe(true);
      expect(result.events).toEqual(['BEGIN', 'ROLLBACK']);
    }),
  2000,
);

for (const phase of ['COMMIT', 'ROLLBACK']) {
  it.effect(
    `interruption waits for native ${phase} and preserves a later SQL failure`,
    () =>
      Effect.gen(function* preserveSettlementFailure() {
        const failure = new SqlError({
          reason: new ConnectionError({ cause: new Error(`${phase} rejected`) }),
        });
        const started = yield* Deferred.make<null>();
        const release = yield* Deferred.make<null>();
        const h = yield* harness((statement) =>
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
        expect(fiber.pollUnsafe()).toBe(undefined);
        yield* Deferred.succeed(release, null);
        yield* Fiber.join(interrupt);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) {
          throw new Error('Expected assertion to hold');
        }
        // Native settlement defects take precedence over pending interruption.
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect === failure,
          ),
        ).toBe(true);
      }),
    2000,
  );
}
