import { NodeCrypto } from '@effect/platform-node';
import { Array as Arr, Crypto, Effect, Order, Result, Schema } from 'effect';
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

import { PaymentRefundableItemsBasisSchema } from '../../shared/domain/payment-refund-basis.ts';
import { computePaymentFunds, PaymentFundsLedger } from '../../src/domain/coverage.ts';
import { cancellationMaterialRequest } from '../../src/domain/refund-admission.ts';
import { paymentFundsSnapshotOf } from '../../src/persistence/payment-aggregate-persistence.ts';
import type { PaymentAggregateRecord } from '../../src/persistence/payment-aggregate-persistence.ts';
import { failureCodeOf, paymentTestRelations, provenanceFor, withPersistence } from './database-fixture.ts';
import {
  acceptObservation,
  decideReconciliation,
  itemsRefund,
  refundCaseFor,
  refundItem,
  requestCancellation,
  requestRefund,
} from '../support/refund-action-driver.ts';
import type { RefundCaseOptions } from '../support/refund-action-driver.ts';
import {
  acceptCollectionCorrection,
  acceptReturnEvidence,
  loadPaymentAggregate,
  operationRequestedMessages,
  seedSourceAuthority,
  transitionOperation,
  refundRuntimeContextAccess,
  refundRuntimePermission,
} from '../support/refund-native-runtime.ts';
import type { RefundNativeRuntime } from '../support/refund-native-runtime.ts';

/**
 * #1150 "Also cover" boundaries through the registered refund and cancellation Actions on native
 * PostgreSQL: scope and owner-evidence negatives, item and funds arithmetic, reservation release,
 * duplicate evidence, correction versus reversal, refund routes and cancellation semantics.
 */

const A = refundItem('A', 30_000);
const B = refundItem('B', 30_000);
const C = refundItem('C', 40_000);
const threeItems = [A, B, C] as const;

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
const refundsOf = (aggregate: PaymentAggregateRecord) =>
  aggregate.operations.filter((operation) => operation.kind === 'REFUND');
const remainingOf = (aggregate: PaymentAggregateRecord) => {
  const ledger = computePaymentFunds(paymentFundsSnapshotOf(aggregate));
  return PaymentFundsLedger.$is('Established')(ledger) ? ledger.remaining.amountMinor : -1;
};

it.live('#1150 foreign Payment, purchase items, account and environment never satisfy a refund', () =>
  native(
    Effect.gen(function* foreignScopeNegatives() {
      const owner = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const foreign = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      // Another Tenant / Selling Legal Entity cannot even see the Payment.
      const foreignPayment = { ...itemsRefund(owner, 'foreign-payment', [B]), paymentId: owner.payment.paymentId };
      expect(yield* failureCodeOf(requestRefund(foreign, foreignPayment, { items: threeItems }))).toBe(
        'payment_not_found',
      );
      // Items authoritative for another purchase are not refundable items of this one.
      const otherPurchaseItems = yield* failureCodeOf(
        requestRefund(owner, itemsRefund(owner, 'other-purchase', [B]), { items: [] }),
      );
      expect(otherPurchaseItems).toBe('payment_refund_item_not_refundable');

      // Only the exact original gateway account and environment can execute a gateway refund.
      const unrouted = yield* newRefundCase({ amountMinor: 100_000, collected: true, gatewayRoute: false });
      yield* seedSourceAuthority(unrouted.native.database, unrouted.scope, {
        accountRef: 'gopay-account-2',
        method: 'ONLINE_GATEWAY',
        sourceKind: 'PAYMENT_GATEWAY',
        sourceSystem: 'GOPAY',
      });
      yield* seedSourceAuthority(unrouted.native.database, unrouted.scope, {
        accountRef: 'gopay-account-1',
        environment: 'sandbox',
        method: 'ONLINE_GATEWAY',
        sourceKind: 'PAYMENT_GATEWAY',
        sourceSystem: 'GOPAY',
      });
      expect(
        yield* failureCodeOf(
          requestRefund(unrouted, itemsRefund(unrouted, 'other-account', [B]), { items: threeItems }),
        ),
      ).toBe('payment_refund_route_unavailable');
      const [ownerAggregate, unroutedAggregate] = yield* Effect.all(
        [
          loadPaymentAggregate(owner.native.database, owner.scope, owner.payment.paymentId),
          loadPaymentAggregate(unrouted.native.database, unrouted.scope, unrouted.payment.paymentId),
        ],
        { concurrency: 1 },
      );
      expect(refundsOf(ownerAggregate)).toHaveLength(0);
      expect(refundsOf(unroutedAggregate)).toHaveLength(0);
    }),
  ),
);

it.live('#1150 item-sum and item-evidence mismatches are rejected', () =>
  native(
    Effect.gen(function* itemMismatches() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const owners = { items: threeItems };
      const codes = yield* Effect.all(
        [
          failureCodeOf(requestRefund(refundCase, itemsRefund(refundCase, 'sum', [A, B], 50_000), owners)),
          failureCodeOf(
            requestRefund(
              refundCase,
              itemsRefund(refundCase, 'evidence', [{ ...B, sourceEvidenceRef: 'invented' }]),
              owners,
            ),
          ),
          failureCodeOf(
            requestRefund(refundCase, itemsRefund(refundCase, 'inflated', [refundItem('B', 35_000)]), owners),
          ),
        ],
        { concurrency: 1 },
      );
      expect(codes).toEqual([
        'payment_refund_item_fractioned',
        'payment_refund_item_mismatch',
        'payment_refund_item_mismatch',
      ]);
    }),
  ),
);

it.live('#1150 all remaining refundable items are refunded in one request and nothing remains', () =>
  native(
    Effect.gen(function* allRemainingItems() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const owners = { items: threeItems };
      const all = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-all', [C, A, B]), owners);
      expect(all.operation.amount.amountMinor).toBe(100_000);
      // Canonical item order: a reordered selection is the same immutable basis.
      expect(Schema.is(PaymentRefundableItemsBasisSchema)(all.refundBasis) ? all.refundBasis.items : []).toEqual([
        A,
        B,
        C,
      ]);
      const replay = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-all', [A, B, C]), owners);
      expect(replay.replayed).toBe(true);
      expect(yield* failureCodeOf(requestRefund(refundCase, itemsRefund(refundCase, 'again', [A]), owners))).toBe(
        'payment_refundable_funds_exceeded',
      );
      const aggregate = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      expect(
        Arr.sort(
          aggregate.activeClaims.map((claim) => claim.itemRef),
          Order.String,
        ),
      ).toEqual(['A', 'B', 'C']);
      expect(remainingOf(aggregate)).toBe(0);
    }),
  ),
);

it.live('#1150 independent non-overlapping refunds each reserve only their own items and funds', () =>
  native(
    Effect.gen(function* independentRefunds() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const owners = { items: threeItems };
      const first = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-a', [A]), owners);
      const second = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-c', [C]), owners);
      expect(first.operation.operationId).not.toBe(second.operation.operationId);
      const aggregate = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      expect(refundsOf(aggregate).map((operation) => operation.operationKey)).toEqual(['refund-a', 'refund-c']);
      expect(remainingOf(aggregate)).toBe(30_000);
      const messages = yield* Effect.all(
        [
          operationRequestedMessages(refundCase.native, refundCase.scope, first.operation.operationId),
          operationRequestedMessages(refundCase.native, refundCase.scope, second.operation.operationId),
        ],
        { concurrency: 1 },
      );
      expect(messages.map((rows) => rows.length)).toEqual([1, 1]);
    }),
  ),
);

it.live('#1150 definitive non-execution releases the reservation for a new legitimate refund', () =>
  native(
    Effect.gen(function* releaseOnNonExecution() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const owners = { items: threeItems };
      const failed = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-b', [B]), owners);
      // A conflict alone never releases; only definitive non-execution does.
      yield* transitionOperation(refundCase.native.database, refundCase.scope, {
        operationId: failed.operation.operationId,
        paymentId: refundCase.payment.paymentId,
        to: 'CONFLICT',
      });
      expect(
        yield* failureCodeOf(requestRefund(refundCase, itemsRefund(refundCase, 'while-conflict', [B]), owners)),
      ).toBe('payment_refund_item_reserved');
      yield* transitionOperation(refundCase.native.database, refundCase.scope, {
        operationId: failed.operation.operationId,
        paymentId: refundCase.payment.paymentId,
        to: 'NOT_EFFECTED_CONFIRMED',
      });
      const retried = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-b-retry', [B]), owners);
      expect(retried.operation.operationId).not.toBe(failed.operation.operationId);
      const aggregate = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      expect(aggregate.activeClaims.map((claim) => claim.operationId)).toEqual([retried.operation.operationId]);
      expect(remainingOf(aggregate)).toBe(70_000);
    }),
  ),
);

it.live('#1150 duplicate refund-effect evidence completes the refund and returns the funds once', () =>
  native(
    Effect.gen(function* duplicateEffectEvidence() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const refund = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-b', [B]), { items: threeItems });
      const evidence = {
        operationId: refund.operation.operationId,
        paymentId: refundCase.payment.paymentId,
        to: 'EFFECT_CONFIRMED' as const,
      };
      const writes = yield* Effect.all(
        [
          transitionOperation(refundCase.native.database, refundCase.scope, evidence),
          transitionOperation(refundCase.native.database, refundCase.scope, evidence),
          transitionOperation(refundCase.native.database, refundCase.scope, evidence),
        ],
        { concurrency: 1 },
      );
      expect(writes.map((write) => write.written)).toEqual([true, false, false]);
      const aggregate = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      const ledger = computePaymentFunds(paymentFundsSnapshotOf(aggregate));
      expect(PaymentFundsLedger.$is('Established')(ledger)).toBe(true);
      if (PaymentFundsLedger.$is('Established')(ledger)) {
        expect(ledger.confirmedReturned.amountMinor).toBe(30_000);
        expect(ledger.reserved.amountMinor).toBe(0);
        expect(ledger.remaining.amountMinor).toBe(70_000);
      }
    }),
  ),
);

it.live('#1150 source correction versus real reversal: each reduces Current refundable funds once', () =>
  native(
    Effect.gen(function* correctionVersusReversal() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const owners = { items: [refundItem('A', 20_000), refundItem('B', 30_000), refundItem('C', 50_000)] };
      // A real later return of 200 CZK.
      const reversal = yield* requestRefund(
        refundCase,
        itemsRefund(refundCase, 'refund-a', [refundItem('A', 20_000)]),
        owners,
      );
      yield* transitionOperation(refundCase.native.database, refundCase.scope, {
        operationId: reversal.operation.operationId,
        paymentId: refundCase.payment.paymentId,
        to: 'EFFECT_CONFIRMED',
      });
      // A qualified correction: 300 CZK of the original receipt report was erroneous; no money moved.
      yield* acceptCollectionCorrection(refundCase.native.database, refundCase.scope, {
        amountMinor: 30_000,
        collectOperationId: refundCase.payment.collectOperationId,
        paymentId: refundCase.payment.paymentId,
      });
      const aggregate = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      const ledger = computePaymentFunds(paymentFundsSnapshotOf(aggregate));
      expect(PaymentFundsLedger.$is('Established')(ledger)).toBe(true);
      if (PaymentFundsLedger.$is('Established')(ledger)) {
        expect(ledger.collected.amountMinor).toBe(70_000);
        expect(ledger.confirmedReturned.amountMinor).toBe(20_000);
        expect(ledger.remaining.amountMinor).toBe(50_000);
      }
      // The correction is not a refund: no REFUND was invented and the original collection stays recorded.
      expect(refundsOf(aggregate)).toHaveLength(1);
      expect(
        yield* failureCodeOf(
          requestRefund(
            refundCase,
            itemsRefund(refundCase, 'refund-b-c', [refundItem('B', 30_000), refundItem('C', 50_000)]),
            owners,
          ),
        ),
      ).toBe('payment_refundable_funds_exceeded');
      const remaining = yield* requestRefund(
        refundCase,
        itemsRefund(refundCase, 'refund-c', [refundItem('C', 50_000)]),
        owners,
      );
      expect(remaining.operation.amount.amountMinor).toBe(50_000);
    }),
  ),
);

const gopayGateway = {
  accountRef: 'gopay-account-1',
  environment: 'production',
  sourceKind: 'PAYMENT_GATEWAY',
  sourceSystem: 'GOPAY',
} as const;
const seedGatewayOutcomeAuthority = (refundCase: Effect.Success<ReturnType<typeof newRefundCase>>) =>
  seedSourceAuthority(refundCase.native.database, refundCase.scope, {
    accountRef: gopayGateway.accountRef,
    factFamily: 'GATEWAY_OUTCOME',
    method: 'ONLINE_GATEWAY',
    refundRoute: false,
    sourceKind: gopayGateway.sourceKind,
    sourceSystem: gopayGateway.sourceSystem,
  });

it.live(
  '#1150 Prior return evidence reduces the remaining budget: closing its held case never frees the returned 400 CZK',
  () =>
    native(
      Effect.gen(function* closedReturnCase() {
        const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
        yield* seedGatewayOutcomeAuthority(refundCase);
        const owners = { items: [refundItem('A', 40_000), refundItem('B', 60_000)] };
        // A qualified gateway statement: 400 CZK of the same collection already went back to the customer.
        const returned = yield* acceptObservation(refundCase, {
          amount: { amountMinor: 40_000, currency: 'CZK' },
          economicEffectKey: 'gopay:refund:1',
          factFamily: 'GATEWAY_OUTCOME',
          factKind: 'REFUND_CONFIRMED',
          operationId: refundCase.payment.collectOperationId,
          paymentId: refundCase.payment.paymentId,
          source: gopayGateway,
          sourceOccurrenceId: 'gopay-callback-refund-1',
          sourceRevision: 0,
        });
        expect(returned.reconciliationCaseId).toBeDefined();
        yield* Effect.exit(
          decideReconciliation(refundCase, {
            caseId: returned.reconciliationCaseId ?? '',
            decision: { _tag: 'CLOSE_CASE', evidenceRef: 'operator-note-1' },
            reason: 'Customer service confirmed the gateway refund',
          }),
        );
        // Whether or not the case closes, the historical 1000 CZK can never be reserved again.
        expect(['payment_held_for_reconciliation', 'payment_refundable_funds_exceeded']).toContain(
          yield* failureCodeOf(
            requestRefund(
              refundCase,
              itemsRefund(refundCase, 'historical', [refundItem('A', 40_000), refundItem('B', 60_000)]),
              owners,
            ),
          ),
        );
        const aggregate = yield* loadPaymentAggregate(
          refundCase.native.database,
          refundCase.scope,
          refundCase.payment.paymentId,
        );
        expect(refundsOf(aggregate)).toHaveLength(0);
      }),
    ),
);

it.live('#1150 Prior return evidence reduces the remaining budget: accepted gateway return evidence counts once', () =>
  native(
    Effect.gen(function* acceptedReturnEvidence() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const sourceAuthorityId = yield* seedGatewayOutcomeAuthority(refundCase);
      const owners = { items: [refundItem('A', 40_000), refundItem('B', 60_000)] };
      // Two source occurrences proven to describe the same 400 CZK return count once.
      for (const sourceOccurrenceId of ['gopay-callback-1', 'gopay-lookup-1']) {
        yield* acceptReturnEvidence(refundCase.native.database, refundCase.scope, {
          amountMinor: 40_000,
          economicEffectKey: 'gopay:refund:1',
          operationId: refundCase.payment.collectOperationId,
          paymentId: refundCase.payment.paymentId,
          sourceAuthorityId,
          sourceOccurrenceId,
        });
      }
      expect(
        yield* failureCodeOf(
          requestRefund(
            refundCase,
            itemsRefund(refundCase, 'historical', [refundItem('A', 40_000), refundItem('B', 60_000)]),
            owners,
          ),
        ),
      ).toBe('payment_refundable_funds_exceeded');
      const remaining = yield* requestRefund(
        refundCase,
        itemsRefund(refundCase, 'remaining', [refundItem('B', 60_000)]),
        owners,
      );
      expect(remaining.operation.amount.amountMinor).toBe(60_000);
    }),
  ),
);

it.live(
  '#1150 Prior return evidence reduces the remaining budget: unassignable return evidence holds new returns',
  () =>
    native(
      Effect.gen(function* unassignableReturnEvidence() {
        const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
        const sourceAuthorityId = yield* seedGatewayOutcomeAuthority(refundCase);
        yield* acceptReturnEvidence(refundCase.native.database, refundCase.scope, {
          amountMinor: 40_000,
          economicEffectKey: 'gopay:refund:unassigned',
          paymentId: refundCase.payment.paymentId,
          sourceAuthorityId,
          sourceOccurrenceId: 'gopay-callback-unassigned',
        });
        expect(
          yield* failureCodeOf(
            requestRefund(refundCase, itemsRefund(refundCase, 'b', [refundItem('B', 60_000)]), {
              items: [refundItem('B', 60_000)],
            }),
          ),
        ).toBe('payment_held_for_reconciliation');
      }),
    ),
);

it.live('#1150 no refund before collection: a live or definitively failed collection has nothing to return', () =>
  native(
    Effect.gen(function* noRefundBeforeCollection() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: false });
      const owners = { items: threeItems };
      expect(yield* failureCodeOf(requestRefund(refundCase, itemsRefund(refundCase, 'pending', [B]), owners))).toBe(
        'payment_no_established_collection',
      );
      yield* transitionOperation(refundCase.native.database, refundCase.scope, {
        operationId: refundCase.payment.collectOperationId,
        paymentId: refundCase.payment.paymentId,
        to: 'NOT_EFFECTED_CONFIRMED',
      });
      expect(yield* failureCodeOf(requestRefund(refundCase, itemsRefund(refundCase, 'failed', [B]), owners))).toBe(
        'payment_no_established_collection',
      );
    }),
  ),
);

it.live('#1150 original binding unavailable is explicit and never fails over to another account', () =>
  native(
    Effect.gen(function* originalBindingUnavailable() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true, gatewayRoute: false });
      // The original account's authority is revoked; another account of the same provider is active.
      yield* seedSourceAuthority(refundCase.native.database, refundCase.scope, {
        accountRef: 'gopay-account-1',
        method: 'ONLINE_GATEWAY',
        sourceKind: 'PAYMENT_GATEWAY',
        sourceSystem: 'GOPAY',
        status: 'REVOKED',
      });
      yield* seedSourceAuthority(refundCase.native.database, refundCase.scope, {
        accountRef: 'gopay-account-2',
        sourceKind: 'PAYMENT_GATEWAY',
        sourceSystem: 'GOPAY',
      });
      // The gateway binding port stays unavailable for new selection; refunds never consult it.
      expect(
        yield* failureCodeOf(
          requestRefund(refundCase, itemsRefund(refundCase, 'refund-b', [B]), { items: threeItems }),
        ),
      ).toBe('payment_refund_route_unavailable');
      const aggregate = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      expect(refundsOf(aggregate)).toHaveLength(0);
      expect(aggregate.activeClaims).toHaveLength(0);
    }),
  ),
);

it.live('#1150 pickup refunds use the POS route, else only an explicitly authorized manual route', () =>
  native(
    Effect.gen(function* pickupRefundRoutes() {
      const pickup = {
        amountMinor: 100_000,
        binding: {
          _tag: 'PICKUP_CAPABILITY',
          capabilityEvidenceRef: 'pickup-evidence-1',
          pickupCapabilityRef: 'store-prague-1',
        },
        collected: true,
        method: 'PAY_ON_PICKUP_OR_ON_SITE',
      } as const;
      const manualOnly = yield* newRefundCase(pickup);
      yield* seedSourceAuthority(manualOnly.native.database, manualOnly.scope, {
        accountRef: 'pos-brno-terminal',
        method: 'PAY_ON_PICKUP_OR_ON_SITE',
        pickupCapabilityRef: 'store-brno-1',
        sourceKind: 'LOCAL_POS_OPERATOR',
        sourceSystem: 'store-pos',
      });
      // A method-neutral manual route is not an explicit authorization for pickup refunds.
      yield* seedSourceAuthority(manualOnly.native.database, manualOnly.scope, {
        accountRef: 'manual-refunds',
        sourceKind: 'MANUAL_EXTERNAL_REFUND',
        sourceSystem: 'finance-desk',
      });
      expect(
        yield* failureCodeOf(requestRefund(manualOnly, itemsRefund(manualOnly, 'neutral', [B]), { items: threeItems })),
      ).toBe('payment_refund_route_unavailable');
      yield* seedSourceAuthority(manualOnly.native.database, manualOnly.scope, {
        accountRef: 'manual-pickup-refunds',
        method: 'PAY_ON_PICKUP_OR_ON_SITE',
        sourceKind: 'MANUAL_EXTERNAL_REFUND',
        sourceSystem: 'finance-desk',
      });
      const manual = yield* requestRefund(manualOnly, itemsRefund(manualOnly, 'manual', [B]), { items: threeItems });
      expect(manual.executionRoute?.routeKind).toBe('MANUAL_EXTERNAL');

      const withPos = yield* newRefundCase(pickup);
      yield* seedSourceAuthority(withPos.native.database, withPos.scope, {
        accountRef: 'manual-pickup-refunds',
        method: 'PAY_ON_PICKUP_OR_ON_SITE',
        sourceKind: 'MANUAL_EXTERNAL_REFUND',
        sourceSystem: 'finance-desk',
      });
      const exactPos = yield* seedSourceAuthority(withPos.native.database, withPos.scope, {
        accountRef: 'pos-terminal-1',
        pickupCapabilityRef: pickup.binding.pickupCapabilityRef,
        sourceKind: 'LOCAL_POS_OPERATOR',
        sourceSystem: 'store-pos',
      });
      const viaPos = yield* requestRefund(withPos, itemsRefund(withPos, 'pos', [B]), { items: threeItems });
      expect(viaPos.executionRoute).toMatchObject({ routeKind: 'LOCAL_POS', sourceAuthorityId: exactPos });
    }),
  ),
);

it.live(
  '#1150 an offline collection cannot start an unsupported cancellation but can replay one already admitted',
  () =>
    native(
      Effect.gen(function* offlineCancellation() {
        const refundCase = yield* newRefundCase({
          amountMinor: 100_000,
          binding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
          collected: false,
          method: 'BANK_TRANSFER_ADVANCE',
        });
        const { collectOperationId, paymentId } = refundCase.payment;
        const { native: runtime, scope } = refundCase;
        const initial = yield* loadPaymentAggregate(runtime.database, scope, paymentId);
        const request = {
          operationKey: 'offline-cancel',
          paymentId,
          reason: 'Customer abandoned the checkout',
          targetOperationId: collectOperationId,
        };
        const refused = yield* Effect.result(requestCancellation(refundCase, request));
        expect(Result.isFailure(refused) ? refused.failure.code : undefined).toBe(
          'payment_cancellation_target_invalid',
        );
        expect(yield* loadPaymentAggregate(runtime.database, scope, paymentId)).toEqual(initial);

        // Seed the row an older Action could admit, then replay the same material via the current Action.
        const provenance = yield* provenanceFor(scope);
        const admitted = yield* withPersistence(runtime.database, scope, (persistence) =>
          persistence.insertOperation({
            amount: initial.payment.amount,
            binding: initial.payment.executionBinding,
            initialOutcome: 'PENDING',
            kind: 'CANCEL_OR_VOID',
            materialRequest: cancellationMaterialRequest(request),
            operationKey: request.operationKey,
            paymentId,
            provenance,
            targetOperationId: collectOperationId,
          }),
        );
        const beforeReplay = yield* loadPaymentAggregate(runtime.database, scope, paymentId);
        expect(yield* requestCancellation(refundCase, request)).toMatchObject({
          operation: { operationId: admitted.record.operationId },
          replayed: true,
        });
        expect(yield* loadPaymentAggregate(runtime.database, scope, paymentId)).toEqual(beforeReplay);
        expect(yield* operationRequestedMessages(runtime, scope, admitted.record.operationId)).toHaveLength(0);
      }),
    ),
);

it.live('#1150 cancellation stops only a live collection of the same Payment and counts once', () =>
  native(
    Effect.gen(function* cancellationSemantics() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: false });
      const { collectOperationId, paymentId } = refundCase.payment;
      const request = {
        operationKey: 'cancel-1',
        paymentId,
        reason: 'Customer abandoned the checkout',
        targetOperationId: collectOperationId,
      };
      const first = yield* requestCancellation(refundCase, request);
      const replay = yield* requestCancellation(refundCase, request);
      expect(first.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      expect(replay.operation.operationId).toBe(first.operation.operationId);
      // The same key with another meaning, or a new key while the first is unresolved, conflicts.
      const codes = yield* Effect.all(
        [
          failureCodeOf(requestCancellation(refundCase, { ...request, reason: 'A different reason' })),
          failureCodeOf(requestCancellation(refundCase, { ...request, operationKey: 'cancel-2' })),
          failureCodeOf(
            requestCancellation(refundCase, {
              ...request,
              operationKey: 'cancel-cancel',
              targetOperationId: first.operation.operationId,
            }),
          ),
          failureCodeOf(
            requestCancellation(refundCase, {
              ...request,
              operationKey: 'cancel-unknown',
              targetOperationId: '99999999-9999-4999-8999-999999999999',
            }),
          ),
        ],
        { concurrency: 1 },
      );
      expect(codes).toEqual([
        'payment_operation_material_conflict',
        'payment_cancellation_in_progress',
        'payment_cancellation_target_invalid',
        'payment_operation_not_found',
      ]);
      const aggregate = yield* loadPaymentAggregate(refundCase.native.database, refundCase.scope, paymentId);
      expect(aggregate.operations.filter((operation) => operation.kind === 'CANCEL_OR_VOID')).toHaveLength(1);
      const messages = yield* operationRequestedMessages(
        refundCase.native,
        refundCase.scope,
        first.operation.operationId,
      );
      expect(messages).toHaveLength(1);
      // Definitive non-collection: nothing is left to cancel.
      yield* transitionOperation(refundCase.native.database, refundCase.scope, {
        operationId: collectOperationId,
        paymentId,
        to: 'NOT_EFFECTED_CONFIRMED',
      });
      expect(
        yield* failureCodeOf(requestCancellation(refundCase, { ...request, operationKey: 'cancel-after-failure' })),
      ).toBe('payment_cancellation_target_not_live');
    }),
  ),
);
