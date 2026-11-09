import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect, Option, Predicate, Schema } from 'effect';
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

import {
  computePaymentFunds,
  decidePrepaidCoverage,
  isPrepaidProofCurrent,
  PaymentFundsLedger,
  PrepaidCoverageDecision,
  refundItemAvailability,
} from '../../src/domain/coverage.ts';
import { PaymentCodDeliveryOfferBindingSchema } from '../../shared/domain/payment-execution-binding.ts';
import {
  PaymentFailedCommitmentCompensationBasisSchema,
  PaymentRefundableItemsBasisSchema,
} from '../../shared/domain/payment-refund-basis.ts';
import type { PaymentRefundBasis } from '../../shared/domain/payment-refund-basis.ts';
import { OutboxPayloadSchema as OperationRequestedPayloadSchema } from '../../shared/outbox/payment-core-operation-requested-v1.ts';
import { requestPaymentRefundAction } from '../../src/actions/request-payment-refund.action.ts';
import { paymentFundsSnapshotOf } from '../../src/persistence/payment-aggregate-persistence.ts';
import type { PaymentAggregateRecord } from '../../src/persistence/payment-aggregate-persistence.ts';
import { failureCodeOf, paymentTestRelations } from './database-fixture.ts';
import {
  closedCommitment,
  compensationRefund,
  itemsRefund,
  refundCaseFor,
  refundItem,
  refundOwners,
  requestCancellation,
  requestRefund,
} from '../support/refund-action-driver.ts';
import type { RefundCaseOptions } from '../support/refund-action-driver.ts';
import {
  LATER_COMPOSITION_REVISION,
  loadPaymentAggregate,
  openAmbiguousFundsCase,
  operationRequestedMessages,
  seedSourceAuthority,
  transitionOperation,
  refundRuntimeContextAccess,
  refundRuntimePermission,
} from '../support/refund-native-runtime.ts';
import type { RefundNativeRuntime } from '../support/refund-native-runtime.ts';

/**
 * #1150 acceptance through the registered `request-payment-refund` / `request-payment-cancellation`
 * Actions, the Core Action runtime and native PostgreSQL. Downstream owners appear only as named
 * public-contract fixtures; qualified outcome evidence is applied with the foundation primitive that
 * the evidence lanes' Actions use.
 */

const A = refundItem('A', 30_000);
const B = refundItem('B', 30_000);
const C = refundItem('C', 40_000);
const threeItems = [A, B, C] as const;

const ledgerOf = (aggregate: PaymentAggregateRecord) => computePaymentFunds(paymentFundsSnapshotOf(aggregate));
const refundOperations = (aggregate: PaymentAggregateRecord) =>
  aggregate.operations.filter((operation) => operation.kind === 'REFUND');
const availabilityOf = (aggregate: PaymentAggregateRecord, itemRef: string) => {
  const outcomes = new Map(aggregate.operations.map((operation) => [operation.operationId, operation.outcome]));
  return refundItemAvailability(
    aggregate.activeClaims.map((claim) => ({
      active: true,
      itemRef: claim.itemRef,
      operationOutcome: outcomes.get(claim.operationId) ?? 'NOT_EFFECTED_CONFIRMED',
    })),
    itemRef,
  );
};
const commitmentAnswer = (answer: 'OUTCOME_UNKNOWN' | 'ATTEMPT_OPEN' | 'TIMEOUT') => ({
  commitment: { ...closedCommitment, answer },
});
const itemsOf = (basis: PaymentRefundBasis) => (Schema.is(PaymentRefundableItemsBasisSchema)(basis) ? basis.items : []);

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

it.live('#1150 Refund one item from a three-item Order: B is refunded whole and A and C stay refundable', () =>
  native(
    Effect.gen(function* refundOneOfThreeItems() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const result = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-b', [B]), { items: threeItems });

      expect(result.replayed).toBe(false);
      expect(result.operation.kind).toBe('REFUND');
      expect(result.operation.outcome).toBe('PENDING');
      expect(result.operation.amount).toEqual({ amountMinor: 30_000, currency: 'CZK' });
      expect(itemsOf(result.refundBasis)).toEqual([B]);
      expect(result.executionRoute?.routeKind).toBe('ORIGINAL_GATEWAY_BINDING');

      const afterB = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      const [refund] = refundOperations(afterB);
      expect(refund?.targetOperationId).toBe(refundCase.payment.collectOperationId);
      expect(availabilityOf(afterB, 'B')).toBe('RESERVED_BY_PENDING_REFUND');
      expect(availabilityOf(afterB, 'A')).toBe('AVAILABLE');
      expect(availabilityOf(afterB, 'C')).toBe('AVAILABLE');

      // A and C stay refundable, subject to the same funds guard.
      const rest = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-a-c', [A, C]), {
        items: threeItems,
      });
      expect(rest.operation.amount.amountMinor).toBe(70_000);
      const afterAll = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      const ledger = ledgerOf(afterAll);
      expect(PaymentFundsLedger.$is('Established')(ledger)).toBe(true);
      if (PaymentFundsLedger.$is('Established')(ledger)) {
        expect(ledger.reserved.amountMinor).toBe(100_000);
        expect(ledger.remaining.amountMinor).toBe(0);
      }
    }),
  ),
);

it.live('#1150 Attempt to refund half of one item: 250 CZK of a 500 CZK item is rejected', () =>
  native(
    Effect.gen(function* refuseHalfAnItem() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const itemB = refundItem('B', 50_000);
      const owners = { items: [itemB] };
      // The complete item with a smaller requested amount.
      expect(
        yield* failureCodeOf(requestRefund(refundCase, itemsRefund(refundCase, 'half-1', [itemB], 25_000), owners)),
      ).toBe('payment_refund_item_fractioned');
      // A Payment-made subdivision of the authoritative item.
      expect(
        yield* failureCodeOf(
          requestRefund(refundCase, itemsRefund(refundCase, 'half-2', [refundItem('B', 25_000)]), owners),
        ),
      ).toBe('payment_refund_item_fractioned');
      const aggregate = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      expect(refundOperations(aggregate)).toHaveLength(0);
      expect(aggregate.activeClaims).toHaveLength(0);
    }),
  ),
);

it.live('#1150 Two concurrent refunds overlap: a reserved item conflicts and no new key or basis evades it', () =>
  native(
    Effect.gen(function* overlappingRefundsConflict() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const owners = { commitment: closedCommitment, items: threeItems };
      const first = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-b', [B]), owners);
      yield* transitionOperation(refundCase.native.database, refundCase.scope, {
        operationId: first.operation.operationId,
        paymentId: refundCase.payment.paymentId,
        to: 'INDETERMINATE',
      });

      const codes = yield* Effect.all(
        [
          failureCodeOf(requestRefund(refundCase, itemsRefund(refundCase, 'refund-b-again', [B]), owners)),
          failureCodeOf(requestRefund(refundCase, itemsRefund(refundCase, 'refund-a-b', [A, B]), owners)),
          // Switching to compensation cannot carve the uncertain reservation out of the remainder.
          failureCodeOf(requestRefund(refundCase, compensationRefund(refundCase, 'compensate', 70_000), owners)),
          // The same logical operation with a mutated basis is a material conflict, not a new refund.
          failureCodeOf(requestRefund(refundCase, itemsRefund(refundCase, 'refund-b', [A]), owners)),
        ],
        { concurrency: 1 },
      );
      expect(codes).toEqual([
        'payment_refund_item_reserved',
        'payment_refund_item_reserved',
        'payment_held_for_reconciliation',
        'payment_operation_material_conflict',
      ]);
      const aggregate = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      expect(refundOperations(aggregate).map((operation) => operation.operationKey)).toEqual(['refund-b']);
      expect(aggregate.activeClaims.map((claim) => claim.itemRef)).toEqual(['B']);
    }),
  ),
);

it.live('#1150 Refund response is lost: B stays reserved and the same REFUND keeps its original binding', () =>
  native(
    Effect.gen(function* lostRefundResponse() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const owners = { items: threeItems };
      const payload = itemsRefund(refundCase, 'refund-b', [B]);
      const first = yield* requestRefund(refundCase, payload, owners);
      // The executor may have accepted it, but the response was lost: the outcome is unknown.
      yield* transitionOperation(refundCase.native.database, refundCase.scope, {
        operationId: first.operation.operationId,
        paymentId: refundCase.payment.paymentId,
        to: 'INDETERMINATE',
      });

      const aggregate = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      expect(availabilityOf(aggregate, 'B')).toBe('RESERVED_BY_PENDING_REFUND');
      const ledger = ledgerOf(aggregate);
      expect(PaymentFundsLedger.$is('Established')(ledger) ? ledger.reserved.amountMinor : -1).toBe(30_000);

      // A new authorized invocation of the same logical operation targets that same REFUND.
      const again = yield* requestRefund(refundCase, payload, owners);
      expect(again.replayed).toBe(true);
      expect(again.operation.operationId).toBe(first.operation.operationId);
      expect(again.operation.outcome).toBe('INDETERMINATE');
      expect(again.operation.binding).toEqual(aggregate.payment.executionBinding);
      // The replay reports the original executor stored with the REFUND; nothing is rerouted.
      expect(again.executionRoute).toEqual(first.executionRoute);
      expect(again.executionRoute?.sourceAuthorityId).toBeDefined();
      const messages = yield* operationRequestedMessages(
        refundCase.native,
        refundCase.scope,
        first.operation.operationId,
      );
      expect(messages).toHaveLength(1);
    }),
  ),
);

it.live(
  '#1150 Collection succeeds while cancellation is in flight: collection stays real and funds return by REFUND',
  () =>
    native(
      Effect.gen(function* lateCollectionAfterCancellation() {
        const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: false });
        const { collectOperationId, paymentId } = refundCase.payment;
        const owners = { items: threeItems };
        const cancellation = yield* requestCancellation(refundCase, {
          operationKey: 'cancel-1',
          paymentId,
          reason: 'Customer abandoned the checkout',
          targetOperationId: collectOperationId,
        });
        expect(cancellation.operation.kind).toBe('CANCEL_OR_VOID');
        expect(cancellation.operation.outcome).toBe('PENDING');
        expect(yield* failureCodeOf(requestRefund(refundCase, itemsRefund(refundCase, 'too-early', [B]), owners))).toBe(
          'payment_no_established_collection',
        );

        // Qualified evidence later proves the collection that raced with the cancellation.
        yield* transitionOperation(refundCase.native.database, refundCase.scope, {
          operationId: collectOperationId,
          paymentId,
          to: 'EFFECT_CONFIRMED',
        });
        // While the cancellation is unresolved against a proven collection, new returns are held.
        expect(yield* failureCodeOf(requestRefund(refundCase, itemsRefund(refundCase, 'held', [B]), owners))).toBe(
          'payment_held_for_reconciliation',
        );
        expect(
          yield* failureCodeOf(
            requestCancellation(refundCase, {
              operationKey: 'cancel-2',
              paymentId,
              reason: 'Second attempt to stop the collection',
              targetOperationId: collectOperationId,
            }),
          ),
        ).toBe('payment_cancellation_after_collection');
        yield* transitionOperation(refundCase.native.database, refundCase.scope, {
          operationId: cancellation.operation.operationId,
          paymentId,
          to: 'NOT_EFFECTED_CONFIRMED',
        });

        const refund = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-b', [B]), owners);
        expect(refund.operation.kind).toBe('REFUND');
        const aggregate = yield* loadPaymentAggregate(refundCase.native.database, refundCase.scope, paymentId);
        const collect = aggregate.operations.find((operation) => operation.operationId === collectOperationId);
        expect(collect?.outcome).toBe('EFFECT_CONFIRMED');
        expect(refundOperations(aggregate)[0]?.targetOperationId).toBe(collectOperationId);
      }),
    ),
);

it.live('#1150 Collected payment but commitment proves no Order: compensation reserves the exact remainder', () =>
  native(
    Effect.gen(function* compensateFailedCommitment() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const returned = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-a', [A]), {
        items: threeItems,
      });
      yield* transitionOperation(refundCase.native.database, refundCase.scope, {
        operationId: returned.operation.operationId,
        paymentId: refundCase.payment.paymentId,
        to: 'EFFECT_CONFIRMED',
      });
      // The items owner is unavailable: compensation does not depend on it (H1094-01=A).
      const owners = { commitment: closedCommitment };
      expect(
        yield* failureCodeOf(requestRefund(refundCase, compensationRefund(refundCase, 'comp-full', 100_000), owners)),
      ).toBe('payment_refund_amount_mismatch');
      const compensation = yield* requestRefund(refundCase, compensationRefund(refundCase, 'comp', 70_000), owners);
      expect(Schema.is(PaymentFailedCommitmentCompensationBasisSchema)(compensation.refundBasis)).toBe(true);
      expect(compensation.operation.amount.amountMinor).toBe(70_000);

      const aggregate = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      // No synthetic Order item is reserved for the compensation.
      expect(aggregate.activeClaims.map((claim) => claim.itemRef)).toEqual(['A']);
      const ledger = ledgerOf(aggregate);
      expect(PaymentFundsLedger.$is('Established')(ledger) ? ledger.remaining.amountMinor : -1).toBe(0);
    }),
  ),
);

it.live('#1150 Order outcome remains unknown: timeout, lost response or open Attempt never start compensation', () =>
  native(
    Effect.gen(function* unknownCommitmentOutcome() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const codes = yield* Effect.all(
        [
          failureCodeOf(
            requestRefund(
              refundCase,
              compensationRefund(refundCase, 'unknown', 100_000),
              commitmentAnswer('OUTCOME_UNKNOWN'),
            ),
          ),
          failureCodeOf(
            requestRefund(
              refundCase,
              compensationRefund(refundCase, 'open', 100_000),
              commitmentAnswer('ATTEMPT_OPEN'),
            ),
          ),
          failureCodeOf(
            requestRefund(refundCase, compensationRefund(refundCase, 'timeout', 100_000), commitmentAnswer('TIMEOUT')),
          ),
          // Closure of another Attempt never proves this one.
          failureCodeOf(
            requestRefund(
              refundCase,
              compensationRefund(refundCase, 'foreign', 100_000, 'attempt-of-another-purchase'),
              { commitment: closedCommitment },
            ),
          ),
        ],
        { concurrency: 1 },
      );
      expect(codes).toEqual([
        'payment_compensation_not_established',
        'payment_compensation_not_established',
        'payment_owner_evidence_unavailable',
        'payment_compensation_not_established',
      ]);
      const aggregate = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      expect(refundOperations(aggregate)).toHaveLength(0);
    }),
  ),
);

it.live('#1150 Prior return evidence reduces the remaining budget and ambiguous overlap is held', () =>
  native(
    Effect.gen(function* priorReturnReducesBudget() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const itemsOwner = { items: [refundItem('A', 40_000), refundItem('B', 60_000), refundItem('D', 40_000)] };
      const returned = yield* requestRefund(
        refundCase,
        itemsRefund(refundCase, 'returned-400', [refundItem('A', 40_000)]),
        itemsOwner,
      );
      yield* transitionOperation(refundCase.native.database, refundCase.scope, {
        operationId: returned.operation.operationId,
        paymentId: refundCase.payment.paymentId,
        to: 'EFFECT_CONFIRMED',
      });
      // Reserving the historical 1000 CZK again cannot reuse the 400 CZK already returned.
      expect(
        yield* failureCodeOf(
          requestRefund(refundCase, compensationRefund(refundCase, 'historical', 100_000), {
            commitment: closedCommitment,
          }),
        ),
      ).toBe('payment_refund_amount_mismatch');
      expect(
        yield* failureCodeOf(
          requestRefund(
            refundCase,
            itemsRefund(refundCase, 'over-budget', [refundItem('B', 60_000), refundItem('D', 40_000)]),
            itemsOwner,
          ),
        ),
      ).toBe('payment_refundable_funds_exceeded');
      // Ambiguous evidence about the same funds holds new returns instead of double returning.
      yield* openAmbiguousFundsCase(refundCase.native.database, refundCase.scope, refundCase.payment.paymentId);
      expect(
        yield* failureCodeOf(
          requestRefund(refundCase, itemsRefund(refundCase, 'held', [refundItem('B', 60_000)]), itemsOwner),
        ),
      ).toBe('payment_held_for_reconciliation');
    }),
  ),
);

it.live('#1150 A prior refund is not deducted twice: 1000 collected, 600 confirmed, a 400 item is permitted', () =>
  native(
    Effect.gen(function* priorRefundCountedOnce() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const itemsOwner = { items: [refundItem('A', 60_000), refundItem('B', 40_000)] };
      const confirmed = yield* requestRefund(
        refundCase,
        itemsRefund(refundCase, 'refund-600', [refundItem('A', 60_000)]),
        itemsOwner,
      );
      yield* transitionOperation(refundCase.native.database, refundCase.scope, {
        operationId: confirmed.operation.operationId,
        paymentId: refundCase.payment.paymentId,
        to: 'EFFECT_CONFIRMED',
      });
      const permitted = yield* requestRefund(
        refundCase,
        itemsRefund(refundCase, 'refund-400', [refundItem('B', 40_000)]),
        itemsOwner,
      );
      expect(permitted.operation.amount.amountMinor).toBe(40_000);
      const ledger = ledgerOf(
        yield* loadPaymentAggregate(refundCase.native.database, refundCase.scope, refundCase.payment.paymentId),
      );
      expect(PaymentFundsLedger.$is('Established')(ledger)).toBe(true);
      if (PaymentFundsLedger.$is('Established')(ledger)) {
        expect(ledger.collected.amountMinor).toBe(100_000);
        expect(ledger.confirmedReturned.amountMinor).toBe(60_000);
        expect(ledger.reserved.amountMinor).toBe(40_000);
        expect(ledger.remaining.amountMinor).toBe(0);
      }
    }),
  ),
);

it.live('#1150 Pending return cannot be carved out to create partial compensation', () =>
  native(
    Effect.gen(function* noCarvedOutCompensation() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const owners = { commitment: closedCommitment, items: threeItems };
      const uncertain = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-a', [A]), owners);
      yield* transitionOperation(refundCase.native.database, refundCase.scope, {
        operationId: uncertain.operation.operationId,
        paymentId: refundCase.payment.paymentId,
        to: 'INDETERMINATE',
      });
      const codes = yield* Effect.all(
        [
          failureCodeOf(requestRefund(refundCase, compensationRefund(refundCase, 'remainder', 70_000), owners)),
          failureCodeOf(requestRefund(refundCase, compensationRefund(refundCase, 'whole', 100_000), owners)),
        ],
        { concurrency: 1 },
      );
      expect(codes).toEqual(['payment_held_for_reconciliation', 'payment_held_for_reconciliation']);

      // Once the uncertain return is reconciled as not executed, the exact safe remainder is accepted.
      yield* transitionOperation(refundCase.native.database, refundCase.scope, {
        operationId: uncertain.operation.operationId,
        paymentId: refundCase.payment.paymentId,
        to: 'NOT_EFFECTED_CONFIRMED',
      });
      const compensation = yield* requestRefund(
        refundCase,
        compensationRefund(refundCase, 'whole-after', 100_000),
        owners,
      );
      expect(compensation.operation.amount.amountMinor).toBe(100_000);
    }),
  ),
);

it.live('#1150 Refund and prepaid authorization race: a started refund supersedes the issued coverage revision', () =>
  native(
    Effect.gen(function* refundSupersedesProofCoverage() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const before = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      const proofCoverageRevision = before.payment.coverageRevision;
      expect(
        isPrepaidProofCurrent({
          currentCoverageRevision: proofCoverageRevision,
          decision: decidePrepaidCoverage(paymentFundsSnapshotOf(before)),
          proofCoverageRevision,
        }),
      ).toBe(true);

      const refund = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-b', [B]), { items: threeItems });
      expect(refund.coverageRevision).toBe(proofCoverageRevision + 1);
      const after = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      expect(after.payment.coverageRevision).toBe(proofCoverageRevision + 1);
      const decision = decidePrepaidCoverage(paymentFundsSnapshotOf(after));
      expect(PrepaidCoverageDecision.$is('NotCovered')(decision) && decision.reason).toBe(
        'RETURN_PENDING_OR_INDETERMINATE',
      );
      expect(
        isPrepaidProofCurrent({
          currentCoverageRevision: after.payment.coverageRevision,
          decision,
          proofCoverageRevision,
        }),
      ).toBe(false);
    }),
  ),
);

it.live(
  '#1150 Refund a bank-transfer purchase: the configured bank route gets the canonical REFUND, still PENDING',
  () =>
    native(
      Effect.gen(function* bankTransferRefund() {
        const refundCase = yield* newRefundCase({
          amountMinor: 100_000,
          binding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
          collected: true,
          method: 'BANK_TRANSFER_ADVANCE',
        });
        const authorityId = yield* seedSourceAuthority(refundCase.native.database, refundCase.scope, {
          accountRef: 'merchant-bank-account',
          method: 'BANK_TRANSFER_ADVANCE',
          sourceKind: 'BANK_ACCOUNTING',
          sourceSystem: 'erp-primary',
        });
        const refund = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-b', [B]), {
          items: threeItems,
        });
        expect(refund.executionRoute?.routeKind).toBe('BANK_ACCOUNTING');
        expect(refund.executionRoute?.sourceAuthorityId).toBe(authorityId);
        // Executor acceptance is not completion: only qualified refund-effect evidence completes it.
        expect(refund.operation.outcome).toBe('PENDING');
        const messages = yield* operationRequestedMessages(
          refundCase.native,
          refundCase.scope,
          refund.operation.operationId,
        );
        expect(messages).toHaveLength(1);
        expect(messages[0]?.producerModuleKey).toBe('payment.core');
        // The executor learns its route from the durable request; the operation keeps it immutably.
        const [requested] = yield* Schema.decodeUnknownEffect(Schema.Array(OperationRequestedPayloadSchema))(
          messages.map((message) => message.payloadJson),
        );
        expect(requested?.refundExecutionRoute).toEqual(refund.executionRoute);
        const aggregate = yield* loadPaymentAggregate(
          refundCase.native.database,
          refundCase.scope,
          refundCase.payment.paymentId,
        );
        const stored = aggregate.operations.find((operation) => operation.operationId === refund.operation.operationId);
        expect(stored?.refundExecutionRoute).toEqual(refund.executionRoute);
      }),
    ),
);

it.live('#1150 Refund a COD purchase: the merchant bank route executes it, never the carrier', () =>
  native(
    Effect.gen(function* codRefund() {
      const refundCase = yield* newRefundCase({
        amountMinor: 100_000,
        binding: {
          _tag: 'COD_DELIVERY_OFFER',
          capabilityEvidenceRef: 'cod-capability-1',
          deliveryOfferRef: 'delivery-offer-1',
        },
        collected: true,
        method: 'CASH_ON_DELIVERY',
      });
      // Carrier collection authority, even if flagged as a refund route, is no reverse-refund rail.
      yield* seedSourceAuthority(refundCase.native.database, refundCase.scope, {
        accountRef: 'carrier-cod-account',
        method: 'CASH_ON_DELIVERY',
        sourceKind: 'CARRIER',
        sourceSystem: 'ppl',
      });
      expect(
        yield* failureCodeOf(
          requestRefund(refundCase, itemsRefund(refundCase, 'via-carrier', [B]), { items: threeItems }),
        ),
      ).toBe('payment_refund_route_unavailable');
      yield* seedSourceAuthority(refundCase.native.database, refundCase.scope, {
        accountRef: 'merchant-bank-account',
        sourceKind: 'BANK_ACCOUNTING',
        sourceSystem: 'erp-primary',
      });
      const refund = yield* requestRefund(refundCase, itemsRefund(refundCase, 'via-bank', [B]), { items: threeItems });
      expect(refund.executionRoute?.routeKind).toBe('BANK_ACCOUNTING');
      // The original COD binding is kept on the REFUND; the executor is the merchant bank route.
      const { binding } = refund.operation;
      expect(Schema.is(PaymentCodDeliveryOfferBindingSchema)(binding) && binding.deliveryOfferRef).toBe(
        'delivery-offer-1',
      );
    }),
  ),
);

it.live('#1150 Late refund evidence after a compatible runtime release completes the reservation once', () =>
  native(
    Effect.gen(function* lateRefundEvidence() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const refund = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-b', [B]), { items: threeItems });
      const originalRevision = refund.operation.provenance.compositionRevision;
      const evidence = {
        compositionRevision: LATER_COMPOSITION_REVISION,
        operationId: refund.operation.operationId,
        paymentId: refundCase.payment.paymentId,
        to: 'EFFECT_CONFIRMED' as const,
      };
      const completed = yield* transitionOperation(refundCase.native.database, refundCase.scope, evidence);
      const duplicate = yield* transitionOperation(refundCase.native.database, refundCase.scope, evidence);
      expect(completed.written).toBe(true);
      expect(duplicate.written).toBe(false);

      const aggregate = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      const [stored] = refundOperations(aggregate);
      expect(stored?.outcome).toBe('EFFECT_CONFIRMED');
      // The original operation keeps its R1 provenance; the late evidence carries R2.
      expect(stored?.provenance.compositionRevision).toBe(originalRevision);
      expect(originalRevision).not.toBe(LATER_COMPOSITION_REVISION);
      expect(availabilityOf(aggregate, 'B')).toBe('REFUNDED');
      const ledger = ledgerOf(aggregate);
      expect(PaymentFundsLedger.$is('Established')(ledger) ? ledger.confirmedReturned.amountMinor : -1).toBe(30_000);
      expect(
        yield* failureCodeOf(
          requestRefund(refundCase, itemsRefund(refundCase, 'refund-b-twice', [B]), { items: threeItems }),
        ),
      ).toBe('payment_refund_item_refunded');
      const transitions = yield* refundCase.native.admin.unsafe<{ composition_revision: string; to_outcome: string }>(
        'select composition_revision, to_outcome from payment.operation_outcome_transitions where operation_id = $1 order by outcome_revision',
        [refund.operation.operationId],
      );
      expect(transitions.map((row) => [row.to_outcome, row.composition_revision])).toEqual([
        ['PENDING', originalRevision],
        ['EFFECT_CONFIRMED', LATER_COMPOSITION_REVISION],
      ]);
    }),
  ),
);

it.live('#1150 mixed or untrusted payload shapes never reach the Payment handler', () =>
  native(
    Effect.gen(function* rejectMixedAndUntrustedPayloads() {
      const refundCase = yield* newRefundCase({ amountMinor: 100_000, collected: true });
      const base = itemsRefund(refundCase, 'shape', [B]);
      const run = (untrustedCase: string, payload: Schema.Json) =>
        refundCase.native.actionRuntime
          .runAction({
            payload,
            principal: refundCase.principal,
            registration: requestPaymentRefundAction,
            transport: {
              correlationId: 'payment-refund-shape',
              idempotencyKey: `untrusted-${untrustedCase}`,
            },
          })
          .pipe(
            Effect.provide(refundOwners(refundCase, {})),
            Effect.flip,
            Effect.map((failure) => (Predicate.hasProperty(failure, '_tag') ? failure._tag : 'unknown')),
          );
      const outcomes = yield* Effect.all(
        [
          // Mixed basis: item selection plus compensation evidence in one basis.
          run('mixed-basis', {
            ...base,
            basis: { ...base.basis, attemptRef: 'attempt-1', terminalNonCommitEvidenceRef: 'x' },
          }),
          // An untrusted destination is never part of the request.
          run('destination', { ...base, destination: { iban: 'CZ6508000000192000145399' } }),
          // A non-original currency is not converted.
          run('currency', { ...base, amount: { amountMinor: 30_000, currency: 'EUR' } }),
        ],
        { concurrency: 1 },
      );
      expect(outcomes).toEqual([
        'ActionPayloadValidationError',
        'ActionPayloadValidationError',
        'ActionPayloadValidationError',
      ]);
      const aggregate = yield* loadPaymentAggregate(
        refundCase.native.database,
        refundCase.scope,
        refundCase.payment.paymentId,
      );
      expect(refundOperations(aggregate)).toHaveLength(0);
      expect(Option.isNone(Option.fromNullishOr(aggregate.activeClaims[0]))).toBe(true);
    }),
  ),
);
