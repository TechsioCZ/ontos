import type { PaymentTermDefinitionSnapshot } from '@app/payment-term-catalog-contracts/payment-term';
import { PaymentTermRefSchema } from '@app/payment-term-catalog-contracts/resources/payment-term';
import type { PaymentTermRef } from '@app/payment-term-catalog-contracts/resources/payment-term';
import type { Duration } from 'effect';
import { Data, DateTime, Effect, Match, Schema } from 'effect';

import { paymentAuthorizationRefused } from '../../shared/domain/authorization-proof.ts';
import type {
  PaymentAuthorizationBinding,
  PaymentAuthorizationCondition,
  PaymentAuthorizationInvalidityReason,
  PaymentAuthorizationProof,
  PaymentAuthorizationRefused,
  PaymentAuthorizationTermSemantic,
} from '../../shared/domain/authorization-proof.ts';
import { paymentConflict } from '../../shared/domain/payment-conflict.ts';
import type { PaymentConflict } from '../../shared/domain/payment-conflict.ts';
import { PaymentExecutionBindingSchema } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import { PaymentMonetaryAmountSchema } from '../../shared/domain/payment-money.ts';
import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import { PREPAID_PAYMENT_METHODS } from '../../shared/domain/payment-vocabulary.ts';
import type { PaymentAuthorizationProofKind, PaymentMethod } from '../../shared/domain/payment-vocabulary.ts';
import { decidePrepaidCoverage, PrepaidCoverageDecision } from './coverage.ts';
import type { PaymentFundsSnapshot, PrepaidCoverageDecisionCase } from './coverage.ts';

/**
 * Pure Payment Authorization currentness rules (#1149). Every decision takes the actual owner time
 * read at the validation/issuance boundary (after the Payment row lock wait); the frozen business
 * Order Commitment Time T is only compared as exact Attempt material, never used as a clock.
 */

const sameAmount = Schema.toEquivalence(PaymentMonetaryAmountSchema);
const sameTermRef = Schema.toEquivalence(PaymentTermRefSchema);
const sameExecutionBinding = Schema.toEquivalence(PaymentExecutionBindingSchema);

/** The immutable Payment meaning a proof must match exactly. */
export interface PaymentAuthorizationSubject {
  readonly amount: PaymentMonetaryAmount;
  readonly executionBinding: PaymentExecutionBinding;
  readonly method: PaymentMethod;
  readonly paymentId: string;
  readonly paymentTermRef: PaymentTermRef;
  readonly purchaseCorrelationId: string;
}

const isPrepaidMethod = (method: PaymentMethod): boolean => PREPAID_PAYMENT_METHODS.some((value) => value === method);

/** PREPAID_COVERAGE for prepaid methods; every other Launch method proves its own method condition. */
export const proofKindForMethod = (method: PaymentMethod): PaymentAuthorizationProofKind =>
  isPrepaidMethod(method) ? 'PREPAID_COVERAGE' : 'METHOD_CONDITION';

/** Exact Payment-meaning comparison; any difference means the Attempt is not this Payment's purchase. */
export const subjectMismatchReasons = (
  subject: PaymentAuthorizationSubject,
  binding: PaymentAuthorizationBinding,
): readonly PaymentAuthorizationInvalidityReason[] => {
  const reasons: PaymentAuthorizationInvalidityReason[] = [];
  if (subject.paymentId !== binding.paymentId) {
    reasons.push('PAYMENT_MISMATCH');
  }
  if (subject.purchaseCorrelationId !== binding.purchaseCorrelationId) {
    reasons.push('PURCHASE_MISMATCH');
  }
  if (!sameAmount(subject.amount, binding.amount)) {
    reasons.push('AMOUNT_MISMATCH');
  }
  if (subject.method !== binding.method) {
    reasons.push('METHOD_MISMATCH');
  }
  if (!sameTermRef(subject.paymentTermRef, binding.paymentTermRef)) {
    reasons.push('TERM_MISMATCH');
  }
  if (!sameExecutionBinding(subject.executionBinding, binding.executionBinding)) {
    reasons.push('BINDING_MISMATCH');
  }
  return reasons;
};

/** Exact Attempt comparison of a presented use against the proof's original binding. */
export const attemptMismatchReasons = (
  proof: PaymentAuthorizationBinding,
  presented: PaymentAuthorizationBinding,
): readonly PaymentAuthorizationInvalidityReason[] => {
  const reasons: PaymentAuthorizationInvalidityReason[] = [];
  if (proof.orderCommitmentAttemptId !== presented.orderCommitmentAttemptId) {
    reasons.push('ATTEMPT_MISMATCH');
  }
  if (!DateTime.Equivalence(proof.orderCommitmentTime, presented.orderCommitmentTime)) {
    reasons.push('COMMITMENT_TIME_MISMATCH');
  }
  return [...reasons, ...subjectMismatchReasons(proof, presented)];
};

/**
 * Minimum interval condition `issuedAt <= actualUse < expiresAt` at the actual owner time. A proof
 * that expired is never revived by an earlier T, transaction start, replay or Composition refresh.
 */
export const validityWindowReasons = (
  proof: Pick<PaymentAuthorizationProof, 'expiresAt' | 'issuedAt'>,
  actualUse: DateTime.Utc,
): readonly PaymentAuthorizationInvalidityReason[] => {
  if (DateTime.isLessThan(actualUse, proof.issuedAt)) {
    return ['NOT_YET_VALID'];
  }
  return DateTime.isGreaterThanOrEqualTo(actualUse, proof.expiresAt) ? ['EXPIRED'] : [];
};

/** The proof's validity window: it starts at the actual issuance instant, never at T. */
export const proofValidity = (issuedAt: DateTime.Utc, validity: Duration.Duration) => ({
  expiresAt: DateTime.addDuration(issuedAt, validity),
  issuedAt,
});

/** The requested window of an issued proof, used to recognise an exact issuance replay. */
export const proofValidityDuration = (proof: Pick<PaymentAuthorizationProof, 'expiresAt' | 'issuedAt'>) =>
  DateTime.distance(proof.issuedAt, proof.expiresAt);

/**
 * Prepaid issuance gate: only proven, unreduced, unreserved Current coverage of the exact required
 * amount (or an explicit zero payable) yields a proof. A browser return, QR, provider ACK or a live
 * collection is not coverage.
 */
export const requirePrepaidCoverage = (
  snapshot: PaymentFundsSnapshot,
): Effect.Effect<PaymentAuthorizationCondition, PaymentAuthorizationRefused | PaymentConflict> =>
  PrepaidCoverageDecision.$match(decidePrepaidCoverage(snapshot), {
    Covered: ({ collectOperationId, covered }) =>
      Effect.succeed<PaymentAuthorizationCondition>({ _tag: 'PREPAID_COLLECTION', collectOperationId, covered }),
    Held: ({ reason }) =>
      Effect.fail(
        paymentConflict('payment_held_for_reconciliation', `Payment coverage is held for reconciliation: ${reason}`),
      ),
    NotCovered: ({ reason }) =>
      Effect.fail(
        paymentAuthorizationRefused(
          'payment_authorization_coverage_insufficient',
          `Current prepaid coverage is not sufficient: ${reason}`,
        ),
      ),
    ZeroPayable: ({ required }) => Effect.succeed<PaymentAuthorizationCondition>({ _tag: 'ZERO_PAYABLE', required }),
  });

const NO_REASONS: readonly PaymentAuthorizationInvalidityReason[] = [];
const INSUFFICIENT: readonly PaymentAuthorizationInvalidityReason[] = ['COVERAGE_INSUFFICIENT'];
const HELD: readonly PaymentAuthorizationInvalidityReason[] = ['COVERAGE_HELD'];
const CONDITION_NOT_MET: readonly PaymentAuthorizationInvalidityReason[] = ['METHOD_CONDITION_NOT_MET'];

const coverageDecisionReasons = (
  condition: PaymentAuthorizationCondition,
  decision: PrepaidCoverageDecisionCase,
): readonly PaymentAuthorizationInvalidityReason[] =>
  PrepaidCoverageDecision.$match(decision, {
    Covered: ({ collectOperationId }) =>
      Match.value(condition).pipe(
        Match.tag('PREPAID_COLLECTION', (proven) =>
          proven.collectOperationId === collectOperationId ? NO_REASONS : INSUFFICIENT,
        ),
        Match.orElse(() => INSUFFICIENT),
      ),
    Held: () => HELD,
    NotCovered: () => INSUFFICIENT,
    ZeroPayable: () =>
      Match.value(condition).pipe(
        Match.tag('ZERO_PAYABLE', () => NO_REASONS),
        Match.orElse(() => INSUFFICIENT),
      ),
  });

/**
 * Current prepaid validation: the proof's coverage revision must still be the Payment's revision and
 * the recomputed coverage must still be sufficient for the same collection lineage. Any refund start,
 * indeterminate return, confirmed reduction or accepted correction bumps the revision under the same
 * row lock, so an earlier proof cannot stay usable against stale full coverage.
 */
export const prepaidCurrentnessReasons = (input: {
  readonly condition: PaymentAuthorizationCondition;
  readonly currentCoverageRevision: number;
  readonly proofCoverageRevision: number | undefined;
  readonly snapshot: PaymentFundsSnapshot;
}): readonly PaymentAuthorizationInvalidityReason[] => {
  const revisionReasons: readonly PaymentAuthorizationInvalidityReason[] =
    input.proofCoverageRevision === input.currentCoverageRevision ? [] : ['COVERAGE_REVISION_CHANGED'];
  return [...revisionReasons, ...coverageDecisionReasons(input.condition, decidePrepaidCoverage(input.snapshot))];
};

/** The reference to the exact C15 reusable semantic snapshot retained by the Payment. */
export const termSemanticOf = (snapshot: PaymentTermDefinitionSnapshot): PaymentAuthorizationTermSemantic => ({
  semanticFingerprint: snapshot.semanticFingerprint,
  semanticRevisionId: snapshot.semanticRevisionId,
});

export type MethodConditionCheckCase = Data.TaggedEnum<{
  Met: { readonly condition: PaymentAuthorizationCondition };
  NotMet: { readonly reason: string };
}>;
export const MethodConditionCheck = Data.taggedEnum<MethodConditionCheckCase>();

/**
 * The stable owner identity a method condition is bound to: the entitlement, the Delivery Offer or
 * the pickup capability. A different entitlement that happens to permit the same term never silently
 * renews an old proof.
 */
const sameConditionIdentity = (original: PaymentAuthorizationCondition, current: PaymentAuthorizationCondition) =>
  Match.value(original).pipe(
    Match.tagsExhaustive({
      COD_DELIVERY_OFFER: ({ deliveryOfferRef }) =>
        Match.value(current).pipe(
          Match.tag('COD_DELIVERY_OFFER', (now) => now.deliveryOfferRef === deliveryOfferRef),
          Match.orElse(() => false),
        ),
      DEFERRED_NET_DAYS: ({ entitlementEvidenceRef, netDays }) =>
        Match.value(current).pipe(
          Match.tag(
            'DEFERRED_NET_DAYS',
            (now) => now.entitlementEvidenceRef === entitlementEvidenceRef && now.netDays === netDays,
          ),
          Match.orElse(() => false),
        ),
      PICKUP_CAPABILITY: ({ pickupCapabilityRef }) =>
        Match.value(current).pipe(
          Match.tag('PICKUP_CAPABILITY', (now) => now.pickupCapabilityRef === pickupCapabilityRef),
          Match.orElse(() => false),
        ),
      PREPAID_COLLECTION: () => false,
      ZERO_PAYABLE: () => false,
    }),
  );

/** Current method-condition validation against the proof's original condition. */
export const methodConditionReasons = (
  original: PaymentAuthorizationCondition,
  current: MethodConditionCheckCase,
): readonly PaymentAuthorizationInvalidityReason[] =>
  MethodConditionCheck.$match(current, {
    Met: ({ condition }) => (sameConditionIdentity(original, condition) ? NO_REASONS : CONDITION_NOT_MET),
    NotMet: () => CONDITION_NOT_MET,
  });
