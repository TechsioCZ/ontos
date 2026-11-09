import { PaymentTermDefinitionSnapshotSchema } from '@app/payment-term-catalog-contracts/payment-term';
import { PaymentTermRefSchema } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { Schema } from 'effect';

import { PaymentExecutionBindingSchema } from './payment-execution-binding.ts';
import {
  PaymentAuthorizationIdSchema,
  PaymentAuthorizationIssuanceKeySchema,
  PaymentDeliveryOfferRefSchema,
  PaymentEvidenceRefSchema,
  PaymentIdSchema,
  PaymentOperationIdSchema,
  PaymentOrderCommitmentAttemptIdSchema,
  PaymentPickupCapabilityRefSchema,
  PaymentPurchaseCorrelationIdSchema,
  PaymentRevisionSchema,
} from './payment-identifiers.ts';
import { PaymentMonetaryAmountSchema } from './payment-money.ts';
import { PaymentExecutionProvenanceSchema } from './payment-provenance.ts';
import { PaymentAuthorizationProofKindSchema, PaymentMethodSchema } from './payment-vocabulary.ts';

/**
 * Payment Authorization (#1149): an immutable Payment-owned business proof bound to one exact Order
 * Commitment Attempt. It is distinct from provider preauthorization, Principal Permission, Payment
 * Operation identity, runtime Composition revision and the eventual Order.
 */

/** Owner maximum validity window of one proof; the Attempt may ask for a shorter window. */
export const PAYMENT_AUTHORIZATION_MAXIMUM_VALIDITY_SECONDS = 900;

export const PaymentAuthorizationValiditySecondsSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: PAYMENT_AUTHORIZATION_MAXIMUM_VALIDITY_SECONDS, minimum: 1 }),
);

/**
 * The exact Attempt material a proof is bound to. `orderCommitmentTime` is the frozen business
 * Order Commitment Time T: it is retained as evidence and compared exactly, but proof issuance,
 * validity and use are always evaluated at the actual owner time, never at T.
 */
export const PaymentAuthorizationBindingSchema = Schema.Struct({
  amount: PaymentMonetaryAmountSchema,
  executionBinding: PaymentExecutionBindingSchema,
  method: PaymentMethodSchema,
  orderCommitmentAttemptId: PaymentOrderCommitmentAttemptIdSchema,
  orderCommitmentTime: Schema.DateTimeUtcFromString,
  paymentId: PaymentIdSchema,
  paymentTermRef: PaymentTermRefSchema,
  purchaseCorrelationId: PaymentPurchaseCorrelationIdSchema,
});
export type PaymentAuthorizationBinding = typeof PaymentAuthorizationBindingSchema.Type;

/** Reference to the exact C15 reusable semantic snapshot retained by the Payment. */
export const PaymentAuthorizationTermSemanticSchema = Schema.Struct({
  semanticFingerprint: PaymentTermDefinitionSnapshotSchema.fields.semanticFingerprint,
  semanticRevisionId: PaymentTermDefinitionSnapshotSchema.fields.semanticRevisionId,
});
export type PaymentAuthorizationTermSemantic = typeof PaymentAuthorizationTermSemanticSchema.Type;

/**
 * The method-specific precondition the proof establishes. Prepaid kinds reference proven collection
 * coverage; method-condition kinds reference owner capability/entitlement evidence and never claim
 * that money was collected, an invoice was issued or a due DATE was calculated.
 */
export const PaymentAuthorizationPrepaidCollectionSchema = Schema.TaggedStruct('PREPAID_COLLECTION', {
  collectOperationId: PaymentOperationIdSchema,
  covered: PaymentMonetaryAmountSchema,
});
/** Zero payable purchase: no fictitious collection exists or is required (#1148). */
export const PaymentAuthorizationZeroPayableSchema = Schema.TaggedStruct('ZERO_PAYABLE', {
  required: PaymentMonetaryAmountSchema,
});
export const PaymentAuthorizationDeferredNetDaysSchema = Schema.TaggedStruct('DEFERRED_NET_DAYS', {
  entitlementEvidenceRef: PaymentEvidenceRefSchema,
  netDays: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export const PaymentAuthorizationCodDeliveryOfferSchema = Schema.TaggedStruct('COD_DELIVERY_OFFER', {
  capabilityEvidenceRef: PaymentEvidenceRefSchema,
  deliveryOfferRef: PaymentDeliveryOfferRefSchema,
});
export const PaymentAuthorizationPickupCapabilitySchema = Schema.TaggedStruct('PICKUP_CAPABILITY', {
  capabilityEvidenceRef: PaymentEvidenceRefSchema,
  pickupCapabilityRef: PaymentPickupCapabilityRefSchema,
});
export const PaymentAuthorizationConditionSchema = Schema.Union([
  PaymentAuthorizationPrepaidCollectionSchema,
  PaymentAuthorizationZeroPayableSchema,
  PaymentAuthorizationDeferredNetDaysSchema,
  PaymentAuthorizationCodDeliveryOfferSchema,
  PaymentAuthorizationPickupCapabilitySchema,
]);
export type PaymentAuthorizationCondition = typeof PaymentAuthorizationConditionSchema.Type;

/** The immutable proof as issued; replay and later reads return exactly these original values. */
export const PaymentAuthorizationProofSchema = Schema.Struct({
  authorizationId: PaymentAuthorizationIdSchema,
  binding: PaymentAuthorizationBindingSchema,
  condition: PaymentAuthorizationConditionSchema,
  /** The Current coverage revision a prepaid proof was issued against; absent for method conditions. */
  coverageRevision: Schema.optionalKey(PaymentRevisionSchema),
  expiresAt: Schema.DateTimeUtcFromString,
  issuanceKey: PaymentAuthorizationIssuanceKeySchema,
  /** Actual owner issuance instant, after the Payment row lock wait; never backdated to T. */
  issuedAt: Schema.DateTimeUtcFromString,
  proofKind: PaymentAuthorizationProofKindSchema,
  provenance: PaymentExecutionProvenanceSchema,
  termSemantic: PaymentAuthorizationTermSemanticSchema,
});
export type PaymentAuthorizationProof = typeof PaymentAuthorizationProofSchema.Type;

/** Why a Current validation does not accept a proof. Each reason is a definitive owner fact. */
export const PAYMENT_AUTHORIZATION_INVALIDITY_REASONS = [
  'PROOF_UNKNOWN',
  'ATTEMPT_MISMATCH',
  'PAYMENT_MISMATCH',
  'PURCHASE_MISMATCH',
  'AMOUNT_MISMATCH',
  'METHOD_MISMATCH',
  'TERM_MISMATCH',
  'BINDING_MISMATCH',
  'COMMITMENT_TIME_MISMATCH',
  'NOT_YET_VALID',
  'EXPIRED',
  'COVERAGE_REVISION_CHANGED',
  'COVERAGE_INSUFFICIENT',
  'COVERAGE_HELD',
  'METHOD_CONDITION_NOT_MET',
] as const;
export const PaymentAuthorizationInvalidityReasonSchema = Schema.Literals(PAYMENT_AUTHORIZATION_INVALIDITY_REASONS);
export type PaymentAuthorizationInvalidityReason = typeof PaymentAuthorizationInvalidityReasonSchema.Type;

/**
 * VALID only when every exact binding, the actual-time validity window and the Current owner
 * coverage/condition hold. UNAVAILABLE_TO_VERIFY never means valid: required owner evidence could not
 * be verified now.
 */
export const PAYMENT_AUTHORIZATION_VALIDATION_OUTCOMES = ['VALID', 'NOT_VALID', 'UNAVAILABLE_TO_VERIFY'] as const;
export const PaymentAuthorizationValidationOutcomeSchema = Schema.Literals(PAYMENT_AUTHORIZATION_VALIDATION_OUTCOMES);
export type PaymentAuthorizationValidationOutcome = typeof PaymentAuthorizationValidationOutcomeSchema.Type;

/** Issuance-side refusals specific to Payment Authorization. */
export const PAYMENT_AUTHORIZATION_REFUSAL_CODES = [
  'payment_authorization_binding_mismatch',
  'payment_authorization_coverage_insufficient',
  'payment_authorization_method_condition_not_met',
  'payment_authorization_issuance_conflict',
] as const;
export const PaymentAuthorizationRefusalCodeSchema = Schema.Literals(PAYMENT_AUTHORIZATION_REFUSAL_CODES);
export type PaymentAuthorizationRefusalCode = typeof PaymentAuthorizationRefusalCodeSchema.Type;

export class PaymentAuthorizationRefused extends Schema.TaggedError<PaymentAuthorizationRefused>()(
  'PaymentAuthorizationRefused',
  {
    code: PaymentAuthorizationRefusalCodeSchema,
    reason: Schema.String,
  },
) {}

export const paymentAuthorizationRefused = (
  code: PaymentAuthorizationRefusalCode,
  reason: string,
): PaymentAuthorizationRefused => new PaymentAuthorizationRefused({ code, reason });
