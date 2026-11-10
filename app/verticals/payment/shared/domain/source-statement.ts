import { Schema } from 'effect';

import {
  PaymentDeliveryOfferRefSchema,
  PaymentEconomicEffectKeySchema,
  PaymentEvidenceRefSchema,
  PaymentIdSchema,
  PaymentObservationIdSchema,
  PaymentOperationIdSchema,
  PaymentPickupCapabilityRefSchema,
  PaymentProviderAccountRefSchema,
  PaymentReasonSchema,
  PaymentReconciliationCaseIdSchema,
  PaymentRevisionSchema,
  PaymentSourceAuthorityIdSchema,
  PaymentSourceEnvironmentSchema,
  PaymentSourceOccurrenceIdSchema,
  PaymentSourceSystemSchema,
} from './payment-identifiers.ts';
import { PaymentAmountMinorSchema } from './payment-money.ts';
import {
  PaymentMethodSchema,
  PaymentObservationAcceptanceOutcomeSchema,
  PaymentObservationFactKindSchema,
  PaymentOperationOutcomeSchema,
  PaymentSourceAuthorityStatusSchema,
  PaymentSourceFactFamilySchema,
  PaymentSourceKindSchema,
} from './payment-vocabulary.ts';

/**
 * Public source-statement contract of the external/offline evidence boundary (#1152, ingress half of
 * #1151). Trusted Tenant / Selling Legal Entity never travel in a statement: they come from the
 * operation context only. A transport (Symmy, carrier webhook, ERP export) is never itself the fact
 * owner; the configured source binding plus fact family is.
 */

/** The exact configured source binding a statement claims to come from. */
export const PaymentSourceBindingSchema = Schema.Struct({
  accountRef: PaymentProviderAccountRefSchema,
  environment: PaymentSourceEnvironmentSchema,
  sourceKind: PaymentSourceKindSchema,
  sourceSystem: PaymentSourceSystemSchema,
});
export type PaymentSourceBinding = typeof PaymentSourceBindingSchema.Type;

/**
 * Claimed money of a statement. The currency is the source's own ISO code: Payment never converts it,
 * and a currency other than the Payment's exact currency is refused rather than reinterpreted.
 */
export const PaymentSourceClaimedAmountSchema = Schema.Struct({
  amountMinor: PaymentAmountMinorSchema,
  currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u)),
});
export type PaymentSourceClaimedAmount = typeof PaymentSourceClaimedAmountSchema.Type;

/**
 * Exact correlation the source proves. Same amount, variable symbol or free text are deliberately not
 * part of the contract: they never assign evidence to a Payment.
 */
const correlationFields = {
  operationId: Schema.optionalKey(PaymentOperationIdSchema),
  /** Exact selected pickup/on-site capability of a local statement. */
  pickupCapabilityRef: Schema.optionalKey(PaymentPickupCapabilityRefSchema),
};

/** Statement fields shared by integration ingress and operator/POS local evidence. */
export const paymentSourceStatementFields = {
  ...correlationFields,
  /**
   * Exact claimed money. Optional for non-monetary facts, but a confirmed collection or refund without
   * it is refused as `payment_source_fact_unsupported`.
   */
  amount: Schema.optionalKey(PaymentSourceClaimedAmountSchema),
  /** Set only for SOURCE_CORRECTION: the accepted observation whose statement is disproven. */
  correctsObservationId: Schema.optionalKey(PaymentObservationIdSchema),
  /** Proven identity of the economic effect; several occurrences of one effect count once. */
  economicEffectKey: Schema.optionalKey(PaymentEconomicEffectKeySchema),
  factFamily: PaymentSourceFactFamilySchema,
  factKind: PaymentObservationFactKindSchema,
  source: PaymentSourceBindingSchema,
  /** Authoritative business occurrence time where meaningful; never reception time or frozen T. */
  sourceOccurredAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  sourceOccurrenceId: PaymentSourceOccurrenceIdSchema,
  sourceRevision: Schema.Finite.check(
    Schema.isInt(),
    Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
  ),
} as const;

/** Exact selected Delivery Offer of a COD statement (carrier evidence, integration ingress only). */
export const paymentSourceDeliveryOfferField = {
  deliveryOfferRef: Schema.optionalKey(PaymentDeliveryOfferRefSchema),
} as const;

/** Durable transport receipt time; Payment records its own verification time separately. */
export const paymentSourceReceivedAtField = { receivedAt: Schema.optionalKey(Schema.DateTimeUtcFromString) } as const;

export const paymentSourcePaymentIdField = { paymentId: PaymentIdSchema } as const;
export const paymentSourceOptionalPaymentIdField = { paymentId: Schema.optionalKey(PaymentIdSchema) } as const;

/** Evidence reference and auditable reason a local/operator statement must carry (#1152 manual evidence). */
export const paymentLocalEvidenceFields = {
  evidenceRef: PaymentEvidenceRefSchema,
  reason: PaymentReasonSchema,
} as const;
export const paymentOptionalEvidenceRefField = { evidenceRef: Schema.optionalKey(PaymentEvidenceRefSchema) } as const;

/** Which public Action a statement entered through; each has its own Principal Permission (#1152). */
export const PAYMENT_SOURCE_ENTRIES = ['INTEGRATION', 'LOCAL_EVIDENCE'] as const;
export const PaymentSourceEntrySchema = Schema.Literals(PAYMENT_SOURCE_ENTRIES);
export type PaymentSourceEntry = typeof PaymentSourceEntrySchema.Type;

/** Acceptance outcomes that a successful (committed) statement can have. */
export const PAYMENT_SOURCE_RECORDED_OUTCOMES = [
  'ACCEPTED_OBSERVATION',
  'DUPLICATE',
  'HELD_UNRESOLVED',
  'CONFLICT',
] as const satisfies readonly (typeof PaymentObservationAcceptanceOutcomeSchema.Type)[];
export const PaymentSourceRecordedOutcomeSchema = Schema.Literals(PAYMENT_SOURCE_RECORDED_OUTCOMES);

/** How the Current interpretation treated an accepted statement (#1151 evidence interpretation). */
export const PAYMENT_SOURCE_INTERPRETATIONS = [
  'NO_CHANGE',
  'TRANSITION',
  'CORRECTION',
  'HOLD',
  'CONFLICT',
  'NOT_INTERPRETED',
] as const;
export const PaymentSourceInterpretationSchema = Schema.Literals(PAYMENT_SOURCE_INTERPRETATIONS);

export const PaymentSourceOutcomeChangeSchema = Schema.Struct({
  from: PaymentOperationOutcomeSchema,
  operationId: PaymentOperationIdSchema,
  to: PaymentOperationOutcomeSchema,
});

/** Committed result of one source statement; never a collection/refund acknowledgement by itself. */
export const PaymentSourceStatementResultSchema = Schema.Struct({
  acceptanceOutcome: PaymentSourceRecordedOutcomeSchema,
  /** For DUPLICATE: the recorded decision of the original occurrence. */
  duplicateOfOutcome: Schema.optional(PaymentObservationAcceptanceOutcomeSchema),
  interpretation: PaymentSourceInterpretationSchema,
  observationId: PaymentObservationIdSchema,
  operationId: Schema.optional(PaymentOperationIdSchema),
  outcomeChange: Schema.optional(PaymentSourceOutcomeChangeSchema),
  paymentId: Schema.optional(PaymentIdSchema),
  reconciliationCaseId: Schema.optional(PaymentReconciliationCaseIdSchema),
  sourceAuthorityId: PaymentSourceAuthorityIdSchema,
});
export type PaymentSourceStatementResult = typeof PaymentSourceStatementResultSchema.Type;

/** Source authority configuration (#1152 "Authority by fact family"); one exact scoped authority. */
export const PaymentSourceAuthorityConfigurationSchema = Schema.Struct({
  /** Optimistic fence for an existing authority; omitted to create or to apply idempotently. */
  expectedRevision: Schema.optionalKey(PaymentRevisionSchema),
  factFamily: PaymentSourceFactFamilySchema,
  /** The exact Payment Method this authority covers; omitted for every method its family permits. */
  method: Schema.optionalKey(PaymentMethodSchema),
  reason: PaymentReasonSchema,
  /** True exactly for a configured refund executor/evidence route (fact family REFUND_EXECUTION). */
  refundRoute: Schema.Boolean,
  source: PaymentSourceBindingSchema,
  status: PaymentSourceAuthorityStatusSchema,
});

export const PaymentSourceAuthorityConfigurationResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  factFamily: PaymentSourceFactFamilySchema,
  method: Schema.optional(PaymentMethodSchema),
  refundRoute: Schema.Boolean,
  revision: PaymentRevisionSchema,
  source: PaymentSourceBindingSchema,
  sourceAuthorityId: PaymentSourceAuthorityIdSchema,
  status: PaymentSourceAuthorityStatusSchema,
});

/** Audit evidence of a governed source configuration or operator evidence decision. */
export const PaymentSourceAuditEvidenceSchema = Schema.Struct({ reason: PaymentReasonSchema });

/**
 * Refusals of the source boundary. A refused statement commits nothing: no observation, no coverage
 * change, no acknowledgement of canonical acceptance (#1152 "Public admission and runtime lifetime").
 */
export const PAYMENT_SOURCE_REJECTION_CODES = [
  /** UNAUTHORIZED_SOURCE: no exact configured authority for this source, fact family, method or binding. */
  'payment_source_authority_forbidden',
  /** UNSUPPORTED_FACT: the fact kind is not a fact this family/source can establish. */
  'payment_source_fact_unsupported',
  /** The claimed currency differs from the exact Payment currency; never converted. */
  'payment_source_currency_mismatch',
  /** The same source occurrence and revision was already recorded with different content. */
  'payment_source_occurrence_conflict',
  /** The authority configuration combines an incompatible fact family, source kind, method or route. */
  'payment_source_configuration_invalid',
  /** The optimistic configuration fence does not match the current authority revision. */
  'payment_source_authority_revision_conflict',
  /** The transport receipt time lies after the verification time. */
  'payment_source_received_time_invalid',
] as const;
export const PaymentSourceRejectionCodeSchema = Schema.Literals(PAYMENT_SOURCE_REJECTION_CODES);
export type PaymentSourceRejectionCode = typeof PaymentSourceRejectionCodeSchema.Type;

export class PaymentSourceRejected extends Schema.TaggedError<PaymentSourceRejected>()('PaymentSourceRejected', {
  code: PaymentSourceRejectionCodeSchema,
  reason: Schema.String,
}) {}

export const paymentSourceRejected = (code: PaymentSourceRejectionCode, reason: string): PaymentSourceRejected =>
  new PaymentSourceRejected({ code, reason });
