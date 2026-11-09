import { NodeCrypto } from '@effect/platform-node';
import { Array as Arr, Crypto, Deferred, Effect, Exit, Fiber, Option, Order, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { paymentTestRelations } from './database-fixture.ts';

import type { RequestPaymentRefundPayload } from '../../shared/actions/request-payment-refund.ts';
import {
  acceptObservation,
  itemsRefund,
  refundCaseFor,
  refundItem,
  requestRefund,
} from '../support/refund-action-driver.ts';
import type { RefundCase, RefundCaseOptions, RefundOwnerFixtures } from '../support/refund-action-driver.ts';
import {
  awaitBlockedLockWaiters,
  holdPaymentRowLock,
  loadPaymentAggregate,
  operationRequestedMessages,
  refundRuntimeContextAccess,
  refundRuntimePermission,
} from '../support/refund-native-runtime.ts';
import type { RefundNativeRuntime } from '../support/refund-native-runtime.ts';

/**
 * #1150 "Reservation, remaining coverage and concurrency" on native PostgreSQL. Two registered
 * refund Actions are started while a third transaction holds the Payment row lock; PostgreSQL itself
 * proves both are queued on the owner boundary before the lock is released, then exactly one wins.
 */

const native = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

/** The real Core Action runtime over the worktree database with the registered Payment owner. */
const nativeRuntime = Effect.gen(function* acquireRefundNativeRuntime() {
  const { admin, runtime } = yield* testDatabaseClients;
  const database = yield* makeTestDatabaseFromClient(runtime, paymentTestRelations);
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, paymentTestRelations);
  const actionRuntime = makeActionRuntime(
    { executor: database },
    makeActionRepository(yield* Crypto.Crypto),
    refundRuntimePermission,
    testOperationalScopeResolver,
    {
      ...openActionRuntimeOptions,
      accessDecision: makeScriptedBoundAccessGate('allowed').bound,
      contextAccess: refundRuntimeContextAccess,
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
    },
  );
  return { actionRuntime, admin, coreAdmin, database } satisfies RefundNativeRuntime;
});
const newRefundCase = (options: RefundCaseOptions) =>
  nativeRuntime.pipe(Effect.flatMap((runtime) => refundCaseFor(runtime, options)));

const codeOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? 'committed'
    : Option.match(Exit.findErrorOption(exit), {
        onNone: () => 'defect',
        onSome: (failure) =>
          Predicate.hasProperty(failure, 'code') && Predicate.isString(failure.code) ? failure.code : 'defect',
      });

/** Starts both requests behind a held row lock and returns their exits once the lock is released. */
const raceBehindRowLock = Effect.fn('RefundConcurrency.raceBehindRowLock')(function* raceBehindRowLock(
  refundCase: RefundCase,
  requests: readonly [RequestPaymentRefundPayload, RequestPaymentRefundPayload],
  owners: RefundOwnerFixtures,
) {
  const locked = yield* Deferred.make<number>();
  const release = yield* Deferred.make<boolean>();
  const holder = yield* holdPaymentRowLock(refundCase.native.database, refundCase.scope, refundCase.payment.paymentId, {
    locked,
    release,
  }).pipe(Effect.forkChild);
  const holderPid = yield* Deferred.await(locked);
  const [first, second] = requests;
  const racers = yield* Effect.all(
    [
      Effect.exit(requestRefund(refundCase, first, owners)).pipe(Effect.forkChild),
      Effect.exit(requestRefund(refundCase, second, owners)).pipe(Effect.forkChild),
    ],
    { concurrency: 1 },
  );
  const waiting = yield* awaitBlockedLockWaiters(refundCase.native, holderPid, 2);
  yield* Deferred.succeed(release, true);
  yield* Fiber.join(holder);
  const exits = yield* Effect.all(racers.map(Fiber.join), { concurrency: 'unbounded' });
  return { exits, waiting };
});

it.live('#1150 Two concurrent refunds with overlapping items queue on the row lock: one reserves, one conflicts', () =>
  native(
    Effect.gen(function* overlappingConcurrentRefunds() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const A = refundItem('A', 30_000);
      const B = refundItem('B', 30_000);
      const { exits, waiting } = yield* raceBehindRowLock(
        refundCase,
        [itemsRefund(refundCase, 'refund-b', [B]), itemsRefund(refundCase, 'refund-a-b', [A, B])],
        { items: [A, B] },
      );
      expect(waiting).toBeGreaterThanOrEqual(2);
      expect(Arr.sort(exits.map(codeOf), Order.String)).toEqual(['committed', 'payment_refund_item_reserved']);
      const aggregate = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      expect(aggregate.operations.filter((operation) => operation.kind === 'REFUND')).toHaveLength(1);
      expect(aggregate.activeClaims.filter((claim) => claim.itemRef === 'B')).toHaveLength(1);
    }),
  ),
);

it.live('#1150 Two concurrent refunds over the same remaining funds never exceed the established collection', () =>
  native(
    Effect.gen(function* concurrentFundsGuard() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const A = refundItem('A', 60_000);
      const B = refundItem('B', 60_000);
      const { exits, waiting } = yield* raceBehindRowLock(
        refundCase,
        [itemsRefund(refundCase, 'refund-a', [A]), itemsRefund(refundCase, 'refund-b', [B])],
        { items: [A, B] },
      );
      expect(waiting).toBeGreaterThanOrEqual(2);
      expect(Arr.sort(exits.map(codeOf), Order.String)).toEqual(['committed', 'payment_refundable_funds_exceeded']);
      const aggregate = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      const reserved = aggregate.operations
        .filter((operation) => operation.kind === 'REFUND')
        .reduce((total, operation) => total + operation.amount.amountMinor, 0);
      expect(reserved).toBe(60_000);
    }),
  ),
);

it.live('#1150 Same-operation replay under concurrency counts the REFUND, its items and its request once', () =>
  native(
    Effect.gen(function* concurrentSameOperation() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const B = refundItem('B', 30_000);
      const payload = itemsRefund(refundCase, 'refund-b', [B]);
      // Two distinct authorized invocations (fresh Core idempotency keys) of one logical operation.
      const { exits, waiting } = yield* raceBehindRowLock(refundCase, [payload, payload], { items: [B] });
      expect(waiting).toBeGreaterThanOrEqual(2);
      expect(exits.map(codeOf)).toEqual(['committed', 'committed']);
      const results = exits.flatMap((exit) => (Exit.isSuccess(exit) ? [exit.value] : []));
      expect(results.filter((result) => result.replayed)).toHaveLength(1);
      expect(new Set(results.map((result) => result.operation.operationId)).size).toBe(1);
      const aggregate = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      expect(aggregate.operations.filter((operation) => operation.kind === 'REFUND')).toHaveLength(1);
      expect(aggregate.activeClaims).toHaveLength(1);
      const [result] = results;
      const messages = yield* operationRequestedMessages(
        refundCase.native,
        refundCase.scope,
        result?.operation.operationId ?? '',
      );
      expect(messages).toHaveLength(1);
    }),
  ),
);

it.live(
  '#1150 A refund request and the confirmation of an earlier refund serialize on the owner boundary without deadlock',
  () =>
    native(
      Effect.gen(function* refundRequestVersusConfirmation() {
        const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
        const A = refundItem('A', 30_000);
        const B = refundItem('B', 30_000);
        const owners = { items: [A, B] };
        // An earlier refund through the original gateway route, still PENDING at the provider.
        const earlier = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-a', [A]), owners);
        const locked = yield* Deferred.make<number>();
        const release = yield* Deferred.make<boolean>();
        const holder = yield* holdPaymentRowLock(
          refundCase.native.database,
          refundCase.scope,
          refundCase.payment.paymentId,
          { locked, release },
        ).pipe(Effect.forkChild);
        const holderPid = yield* Deferred.await(locked);
        // A new refund request and the provider's confirmation of the earlier refund queue together.
        const newRefund = yield* Effect.exit(
          requestRefund(refundCase, itemsRefund(refundCase, 'refund-b', [B]), owners),
        ).pipe(Effect.forkChild);
        yield* awaitBlockedLockWaiters(refundCase.native, holderPid, 1);
        const confirmation = yield* Effect.exit(
          acceptObservation(refundCase, {
            amount: { amountMinor: 30_000, currency: 'CZK' },
            factFamily: 'REFUND_EXECUTION',
            factKind: 'REFUND_CONFIRMED',
            operationId: earlier.operation.operationId,
            paymentId: refundCase.payment.paymentId,
            source: {
              accountRef: 'gopay-account-1',
              environment: 'production',
              sourceKind: 'PAYMENT_GATEWAY',
              sourceSystem: 'GOPAY',
            },
            sourceOccurrenceId: 'gopay-refund-a-confirmed',
            sourceRevision: 1,
          }),
        ).pipe(Effect.forkChild);
        const waiting = yield* awaitBlockedLockWaiters(refundCase.native, holderPid, 2);
        yield* Deferred.succeed(release, true);
        yield* Fiber.join(holder);
        const codes = [codeOf(yield* Fiber.join(newRefund)), codeOf(yield* Fiber.join(confirmation))];
        expect(waiting).toBeGreaterThanOrEqual(2);
        expect(codes).toEqual(['committed', 'committed']);
        const aggregate = yield* loadPaymentAggregate(
          refundCase.native.database,
          refundCase.scope,
          refundCase.payment.paymentId,
        );
        const outcomes = aggregate.operations
          .filter((operation) => operation.kind === 'REFUND')
          .map((operation) => operation.outcome);
        expect(Arr.sort(outcomes, Order.String)).toEqual(['EFFECT_CONFIRMED', 'PENDING']);
      }),
    ),
);
