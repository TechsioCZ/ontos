import { DateTime, Schema } from 'effect';

/**
 * A UTC instant: an ISO string on the wire, or the already-decoded `DateTime.Utc`. `HttpApiBuilder` decodes a read's
 * payload once and Read Runtime decodes the same value again with the same request schema, so a request instant must
 * decode idempotently. JSON cannot carry a `DateTime.Utc`, so the wire contract stays exactly as strict, and encoding
 * still emits the ISO string.
 */
export const UtcInstantSchema = Schema.Union([Schema.DateTimeUtcFromString, Schema.DateTimeUtc]);

/**
 * Business instant selecting the applicable Tax Rule meaning; it is part of Tax Decision meaning
 * (#941 F1, #927 F7, #907 F142).
 */
export const TaxRelevantTimeSchema = UtcInstantSchema.pipe(Schema.brand('TaxRelevantTime'));

export type TaxRelevantTime = typeof TaxRelevantTimeSchema.Type;

/**
 * Trusted operation/provenance/currentness time of one Tax evaluation. A distinct type even when the instant
 * coincides with Tax-Relevant Time; it never selects Tax Rule effectivity (#941 F1, #927 F8-F9, #929 F12,
 * #907 F143).
 */
export const TaxEvaluationTimeSchema = UtcInstantSchema.pipe(Schema.brand('TaxEvaluationTime'));

export type TaxEvaluationTime = typeof TaxEvaluationTimeSchema.Type;

/** Commerce-owned Order Commitment Time T captured once for the exact frozen submission (#941 F2, #907 F155). */
export const OrderCommitmentTimeSchema = UtcInstantSchema.pipe(Schema.brand('OrderCommitmentTime'));

export type OrderCommitmentTime = typeof OrderCommitmentTimeSchema.Type;

/**
 * Effective Period `[effective_from, effective_to)`; an absent end is open-ended, a present end lies strictly after
 * the start, so an inverted or empty period is not representable (#929 F4-F10, #941 F5).
 */
export const EffectivePeriodSchema = Schema.Struct({
  effectiveFrom: Schema.DateTimeUtcFromString,
  effectiveTo: Schema.optionalKey(Schema.DateTimeUtcFromString),
}).check(
  Schema.makeFilter(
    ({ effectiveFrom, effectiveTo }) =>
      effectiveTo === undefined ||
      DateTime.isLessThan(effectiveFrom, effectiveTo) ||
      'An Effective Period must end after it starts',
  ),
);

export type EffectivePeriod = typeof EffectivePeriodSchema.Type;
