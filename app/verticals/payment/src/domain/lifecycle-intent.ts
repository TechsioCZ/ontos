import type { PaymentTermRef } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { Array as EffectArray, Data, Equivalence, Match, Option, Schema } from 'effect';

import type { PaymentMethodBranchSelection } from '../../shared/domain/applicability-contract.ts';
import type { PaymentCoverageSummary } from '../../shared/domain/lifecycle-views.ts';
import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import type { PaymentMethod, PaymentOperationOutcome } from '../../shared/domain/payment-vocabulary.ts';
import { computePaymentFunds, PaymentFundsLedger } from './coverage.ts';
import type { PaymentFundsSnapshot } from './coverage.ts';
import { isZeroAmount, sameAmount } from './money.ts';
import { isUnresolvedOutcome } from './operation-lifecycle.ts';

/**
 * Pure lifecycle rules of the Payment intent and its COLLECT start (#1148, #1149). Persistence and
 * owner evidence are supplied by the Actions; these functions only decide.
 */

/** The caller-supplied meaning of a Payment intent, before owner evidence is attached. */
export interface PaymentIntentRequest {
  readonly customerConfigurationId: string;
  readonly payableAmount: PaymentMonetaryAmount;
  readonly paymentTermRef: PaymentTermRef;
  readonly predecessorPaymentId: Option.Option<string>;
  readonly purchaseCorrelationId: string;
  readonly selection: PaymentMethodBranchSelection;
}

/** The persisted meaning of an existing Payment intent. */
export interface PersistedPaymentIntent {
  readonly amount: PaymentMonetaryAmount;
  readonly customerConfigurationId: string;
  readonly executionBinding: PaymentExecutionBinding;
  readonly method: PaymentMethod;
  readonly paymentTermRef: PaymentTermRef;
  readonly predecessorPaymentId?: string | undefined;
  readonly purchaseCorrelationId: string;
}

const sameTermRef = (left: PaymentTermRef, right: PaymentTermRef) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

/** The identity of the selected execution route, as named by a persisted binding. */
const bindingIdentity = (binding: PaymentExecutionBinding): readonly string[] =>
  Match.valueTags(binding, {
    BANK_ACCOUNTING_RECEIPT: () => ['BANK_ACCOUNTING_RECEIPT'],
    COD_DELIVERY_OFFER: ({ deliveryOfferRef }) => ['COD_DELIVERY_OFFER', deliveryOfferRef],
    GATEWAY_ACCOUNT: ({ environment, providerAccountRef, providerFamily }) => [
      'GATEWAY_ACCOUNT',
      providerFamily,
      providerAccountRef,
      environment,
    ],
    PICKUP_CAPABILITY: ({ pickupCapabilityRef }) => ['PICKUP_CAPABILITY', pickupCapabilityRef],
  });

/** The identity of the explicitly selected route; an incomplete selection names nothing. */
const selectionIdentity = (selection: PaymentMethodBranchSelection): Option.Option<readonly string[]> =>
  Match.value(selection).pipe(
    Match.discriminatorsExhaustive('method')({
      BANK_TRANSFER_ADVANCE: () => Option.some(['BANK_ACCOUNTING_RECEIPT']),
      CASH_ON_DELIVERY: ({ deliveryOfferRef }) =>
        Option.map(Option.fromNullishOr(deliveryOfferRef), (ref) => ['COD_DELIVERY_OFFER', ref]),
      DEFERRED_INVOICE: () => Option.some(['BANK_ACCOUNTING_RECEIPT']),
      ONLINE_GATEWAY: ({ selectedBinding }) => Option.map(Option.fromNullishOr(selectedBinding), bindingIdentity),
      PAY_ON_PICKUP_OR_ON_SITE: ({ pickupCapabilityRef }) =>
        Option.map(Option.fromNullishOr(pickupCapabilityRef), (ref) => ['PICKUP_CAPABILITY', ref]),
    }),
  );

const sameIdentity = EffectArray.makeEquivalence(Equivalence.strictEqual<string>());

/** True when the explicit method selection names exactly the route the persisted binding was created from. */
export const selectionMatchesBinding = (
  selection: PaymentMethodBranchSelection,
  binding: PaymentExecutionBinding,
): boolean =>
  Option.match(selectionIdentity(selection), {
    onNone: () => false,
    onSome: (identity) => sameIdentity(identity, bindingIdentity(binding)),
  });

/**
 * Whether a request under an existing intent key restates the same intent. Owner evidence (term
 * snapshot, capability evidence) is not re-derived for a replay: the persisted intent is immutable.
 */
export const isSameIntentMaterial = (existing: PersistedPaymentIntent, request: PaymentIntentRequest): boolean =>
  sameAmount(existing.amount, request.payableAmount) &&
  existing.method === request.selection.method &&
  existing.customerConfigurationId === request.customerConfigurationId &&
  existing.purchaseCorrelationId === request.purchaseCorrelationId &&
  existing.predecessorPaymentId === Option.getOrUndefined(request.predecessorPaymentId) &&
  sameTermRef(existing.paymentTermRef, request.paymentTermRef) &&
  selectionMatchesBinding(request.selection, existing.executionBinding);

export const PredecessorBlockReasonSchema = Schema.Literals([
  'HELD_EVIDENCE',
  'SUPERSEDED',
  'UNRESOLVED_OPERATION',
  'UNRETURNED_COLLECTION',
]);
export type PredecessorBlockReason = typeof PredecessorBlockReasonSchema.Type;

export type PredecessorReleaseDecisionCase = Data.TaggedEnum<{
  /** The predecessor still carries a monetary effect a successor would bypass. */
  Blocked: { readonly blockingOperationId: Option.Option<string>; readonly reason: PredecessorBlockReason };
  /** No live, indeterminate, conflicting or unreturned effect remains: a successor may be created. */
  Released: { readonly predecessorPaymentId: string };
}>;
export const PredecessorReleaseDecision = Data.taggedEnum<PredecessorReleaseDecisionCase>();

/**
 * #1148 "Creating a successor intent never bypasses unresolved or already-proven monetary effects of
 * the predecessor": decided under the predecessor's row lock from its Current aggregate.
 */
export const decidePredecessorRelease = (input: {
  readonly funds: PaymentFundsSnapshot;
  readonly operations: readonly { readonly operationId: string; readonly outcome: PaymentOperationOutcome }[];
  readonly predecessorPaymentId: string;
  readonly successorPaymentId: Option.Option<string>;
}): PredecessorReleaseDecisionCase => {
  const released = PredecessorReleaseDecision.Released({ predecessorPaymentId: input.predecessorPaymentId });
  if (Option.isSome(input.successorPaymentId)) {
    return PredecessorReleaseDecision.Blocked({ blockingOperationId: Option.none(), reason: 'SUPERSEDED' });
  }
  const unresolved = input.operations.find((operation) => isUnresolvedOutcome(operation.outcome));
  if (unresolved !== undefined) {
    return PredecessorReleaseDecision.Blocked({
      blockingOperationId: Option.some(unresolved.operationId),
      reason: 'UNRESOLVED_OPERATION',
    });
  }
  return PaymentFundsLedger.$match(computePaymentFunds(input.funds), {
    Established: ({ collectOperationId, remaining }) =>
      isZeroAmount(remaining)
        ? released
        : PredecessorReleaseDecision.Blocked({
            blockingOperationId: Option.some(collectOperationId),
            reason: 'UNRETURNED_COLLECTION',
          }),
    Held: () => PredecessorReleaseDecision.Blocked({ blockingOperationId: Option.none(), reason: 'HELD_EVIDENCE' }),
    NotCollected: ({ liveCollectOperationId }) =>
      Option.isSome(liveCollectOperationId)
        ? PredecessorReleaseDecision.Blocked({
            blockingOperationId: liveCollectOperationId,
            reason: 'UNRESOLVED_OPERATION',
          })
        : released,
  });
};

/** The caller's restated collection meaning (#1149 COLLECT start). */
export interface CollectionRequest {
  readonly amount: PaymentMonetaryAmount;
  readonly method: PaymentMethod;
}

/** A COLLECT must restate exactly the immutable Payment meaning; anything else is a conflict. */
export const collectionMatchesPayment = (
  payment: { readonly amount: PaymentMonetaryAmount; readonly method: PaymentMethod },
  request: CollectionRequest,
): boolean => sameAmount(payment.amount, request.amount) && payment.method === request.method;

/**
 * Canonical material request of a COLLECT: the caller's restated meaning plus the Payment's original
 * binding. Its hash is the business replay comparator; Core invocation, time and Composition revision
 * are provenance and deliberately not part of it.
 */
export const collectionMaterialRequest = (
  paymentId: string,
  request: CollectionRequest,
  binding: PaymentExecutionBinding,
) => ({
  amountMinor: request.amount.amountMinor,
  binding: bindingIdentity(binding),
  currency: request.amount.currency,
  kind: 'COLLECT',
  method: request.method,
  paymentId,
});

/** Current funds summary for the governed Read; zero payable never shows a fictitious collection. */
export const coverageSummaryOf = (snapshot: PaymentFundsSnapshot): PaymentCoverageSummary => {
  const funds = computePaymentFunds(snapshot);
  if (isZeroAmount(snapshot.required) && PaymentFundsLedger.$is('NotCollected')(funds)) {
    return { _tag: 'ZERO_PAYABLE' };
  }
  return PaymentFundsLedger.$match(funds, {
    Established: ({
      collected,
      collectOperationId,
      confirmedReturned,
      remaining,
      reserved,
    }): PaymentCoverageSummary => ({
      _tag: 'ESTABLISHED',
      collected,
      collectOperationId,
      confirmedReturned,
      remaining,
      reserved,
    }),
    Held: ({ reason }): PaymentCoverageSummary => ({ _tag: 'HELD', reason }),
    NotCollected: ({ liveCollectOperationId }): PaymentCoverageSummary => ({
      _tag: 'NOT_COLLECTED',
      liveCollectOperationId,
    }),
  });
};
