import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect } from 'effect';
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

import type { PaymentOperationOutcome } from '../../shared/domain/payment-vocabulary.ts';
import { failureCodeOf, paymentTestRelations } from './database-fixture.ts';
import {
  closedCommitment,
  compensationRefund,
  itemsRefund,
  refundCaseFor,
  refundItem,
  requestRefund,
} from '../support/refund-action-driver.ts';
import type { RefundCase, RefundCaseOptions } from '../support/refund-action-driver.ts';
import {
  loadPaymentAggregate,
  refundRuntimeContextAccess,
  refundRuntimePermission,
  transitionOperation,
} from '../support/refund-native-runtime.ts';
import type { RefundNativeRuntime } from '../support/refund-native-runtime.ts';

/**
 * #1150 "A conflict does not release reservations whose safety remains unresolved": a REFUND whose
 * definitive non-execution is later overturned (NOT_EFFECTED_CONFIRMED -> CONFLICT -> EFFECT_CONFIRMED)
 * protects its items again, and an item another refund claimed in between is held overlap debt rather
 * than a second claim or a double return. Refunds run through the registered Action on native
 * PostgreSQL; outcome changes use the owner `transitionOperationOutcome` primitive.
 */

const B = refundItem('B', 30_000);
const C = refundItem('C', 40_000);
const owners = { items: [refundItem('A', 30_000), B, C] };

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

const moveTo = (refundCase: RefundCase, operationId: string, to: PaymentOperationOutcome) =>
  transitionOperation(refundCase.native.database, refundCase.scope, {
    operationId,
    paymentId: refundCase.payment.paymentId,
    to,
  });

const refundKeysOf = (refundCase: RefundCase) =>
  loadPaymentAggregate(refundCase.native.database, refundCase.scope, refundCase.payment.paymentId).pipe(
    Effect.map((aggregate) =>
      aggregate.operations.flatMap((operation) => (operation.kind === 'REFUND' ? [operation.operationKey] : [])),
    ),
  );

it.live('#1150 an overturned non-execution protects the refund items again; they are never refunded twice', () =>
  native(
    Effect.gen(function* overturnedNonExecution() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const refund = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-b', [B]), owners);
      const { operationId } = refund.operation;
      yield* moveTo(refundCase, operationId, 'NOT_EFFECTED_CONFIRMED');
      // Later qualified evidence contradicts the non-execution: the refund is unresolved again.
      yield* moveTo(refundCase, operationId, 'CONFLICT');
      expect(
        yield* failureCodeOf(requestRefund(refundCase, itemsRefund(refundCase, 'while-conflict', [B]), owners)),
      ).toBe('payment_refund_item_reserved');
      // Reconciliation proves the refund was effected after all.
      yield* moveTo(refundCase, operationId, 'EFFECT_CONFIRMED');
      expect(
        yield* failureCodeOf(requestRefund(refundCase, itemsRefund(refundCase, 'after-effect', [B]), owners)),
      ).toBe('payment_refund_item_refunded');
      expect(yield* refundKeysOf(refundCase)).toEqual(['refund-b']);
    }),
  ),
);

it.live('#1150 an item reclaimed while its first refund looked not effected becomes held overlap debt', () =>
  native(
    Effect.gen(function* reclaimedItemOverlap() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const first = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-b', [B]), owners);
      yield* moveTo(refundCase, first.operation.operationId, 'NOT_EFFECTED_CONFIRMED');
      // Definitive non-execution legitimately released B; a new refund claims it.
      const second = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-b-retry', [B]), owners);
      yield* moveTo(refundCase, first.operation.operationId, 'CONFLICT');
      yield* moveTo(refundCase, first.operation.operationId, 'EFFECT_CONFIRMED');
      // Two refunds now stand for B: new returns are held, even for an untouched item within the funds.
      expect(yield* failureCodeOf(requestRefund(refundCase, itemsRefund(refundCase, 'refund-c', [C]), owners))).toBe(
        'payment_held_for_reconciliation',
      );
      const held = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      // Never a double claim: B keeps exactly the one live reservation of the retry.
      expect(held.activeClaims.map((claim) => [claim.itemRef, claim.operationId])).toEqual([
        ['B', second.operation.operationId],
      ]);
      // The retry is proven not effected: the overlap is gone, B stays refunded by the first refund.
      yield* moveTo(refundCase, second.operation.operationId, 'NOT_EFFECTED_CONFIRMED');
      expect(
        yield* failureCodeOf(requestRefund(refundCase, itemsRefund(refundCase, 'refund-b-again', [B]), owners)),
      ).toBe('payment_refund_item_refunded');
      const refundC = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-c-after', [C]), owners);
      expect(refundC.operation.amount.amountMinor).toBe(40_000);
      expect(yield* refundKeysOf(refundCase)).toEqual(['refund-b', 'refund-b-retry', 'refund-c-after']);
    }),
  ),
);

it.live('#1150 held overlap debt also holds failed-commitment compensation of the remaining funds', () =>
  native(
    Effect.gen(function* overlapHoldsCompensation() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const first = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-b', [B]), owners);
      yield* moveTo(refundCase, first.operation.operationId, 'NOT_EFFECTED_CONFIRMED');
      const second = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-b-retry', [B]), owners);
      yield* moveTo(refundCase, first.operation.operationId, 'CONFLICT');
      yield* moveTo(refundCase, first.operation.operationId, 'EFFECT_CONFIRMED');
      // Both refunds of B are confirmed, so nothing is reserved and 40 000 looks remaining.
      yield* moveTo(refundCase, second.operation.operationId, 'EFFECT_CONFIRMED');
      // The ambiguous overlap holds every new return, not only item refunds (#1150 coverage).
      expect(
        yield* failureCodeOf(
          requestRefund(refundCase, compensationRefund(refundCase, 'compensate', 40_000), {
            ...owners,
            commitment: closedCommitment,
          }),
        ),
      ).toBe('payment_held_for_reconciliation');
      expect(yield* refundKeysOf(refundCase)).toEqual(['refund-b', 'refund-b-retry']);
    }),
  ),
);
