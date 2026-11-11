import { Deferred, Effect, Fiber } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  collectInput,
  failureCodeOf,
  makeTestScope,
  newPaymentInput,
  paymentTestRelations,
  withPersistence,
} from './database-fixture.ts';

it.live(
  '#1148 two concurrent distinct COLLECT identities serialize on the Payment row lock; one wins, one conflicts',
  () =>
    Effect.scoped(
      Effect.gen(function* rowLockSerialization() {
        const { admin, runtime: runtimeClient } = yield* testDatabaseClients;
        const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
        const scope = yield* makeTestScope;
        const paymentInput = yield* newPaymentInput(scope);
        const created = yield* withPersistence(runtime, scope, (persistence) =>
          persistence.insertPayment(paymentInput),
        );
        const payment = { amountMinor: 100_000, paymentId: created.record.paymentId };
        const [firstInput, secondInput] = yield* Effect.all(
          [collectInput(scope, payment, 'collect-a'), collectInput(scope, payment, 'collect-b')],
          { concurrency: 1 },
        );
        const locked = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();

        // Fiber A takes the Payment row lock and holds it until the test releases it.
        const first = yield* withPersistence(runtime, scope, (persistence) =>
          Effect.gen(function* holdLockThenCollect() {
            yield* persistence.lockPayment(payment.paymentId);
            yield* Deferred.succeed(locked, true);
            yield* Deferred.await(release);
            return yield* persistence.insertOperation(firstInput);
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(locked);

        // Fiber B races with a distinct operation key for the same Payment.
        const second = yield* failureCodeOf(
          withPersistence(runtime, scope, (persistence) => persistence.insertOperation(secondInput)),
        ).pipe(Effect.forkChild);

        // PostgreSQL proves B is blocked on A's row lock (not merely slow) before A proceeds.
        const waitingOnLocks = admin
          .unsafe<{ waiting: number }>(
            `select count(*)::integer as waiting from pg_catalog.pg_stat_activity
             where datname = current_database() and cardinality(pg_catalog.pg_blocking_pids(pid)) > 0
               and wait_event_type = 'Lock'`,
          )
          .pipe(Effect.map((rows) => rows[0]?.waiting ?? 0));
        const awaitBlockedWaiter = (
          remainingChecks: number,
        ): Effect.Effect<number, Effect.Error<typeof waitingOnLocks>> =>
          waitingOnLocks.pipe(
            Effect.flatMap((waiting) =>
              waiting > 0 || remainingChecks === 0
                ? Effect.succeed(waiting)
                : Effect.suspend(() => awaitBlockedWaiter(remainingChecks - 1)),
            ),
          );
        expect(yield* awaitBlockedWaiter(5000)).toBeGreaterThan(0);
        yield* Deferred.succeed(release, true);

        const winner = yield* Fiber.join(first);
        const loserCode = yield* Fiber.join(second);
        expect(winner.written).toBe(true);
        // B waited for the lock, then saw the committed winner: a typed lineage conflict decided
        // under the lock, not a raw unique violation and not a second collection.
        expect(loserCode).toBe('payment_collect_lineage_conflict');

        const aggregate = yield* withPersistence(runtime, scope, (persistence) =>
          persistence.loadAggregate(payment.paymentId),
        );
        expect(aggregate.operations.map((operation) => operation.operationKey)).toEqual(['collect-a']);
      }),
    ),
);
