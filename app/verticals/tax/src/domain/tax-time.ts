import { DateTime, Schema } from 'effect';

/**
 * Business instant selecting the applicable Tax Rule meaning; it is part of Tax Decision meaning
 * (#941 F1, #927 F7, #907 F142).
 */
export const TaxRelevantTimeSchema = Schema.DateTimeUtcFromString.pipe(Schema.brand('TaxRelevantTime'));
export type TaxRelevantTime = typeof TaxRelevantTimeSchema.Type;

/**
 * Trusted operation/provenance/currentness time of one Tax evaluation. A distinct type even when the instant
 * coincides with Tax-Relevant Time; it never selects Tax Rule effectivity (#941 F1, #927 F8-F9, #929 F12,
 * #907 F143).
 */
export const TaxEvaluationTimeSchema = Schema.DateTimeUtcFromString.pipe(Schema.brand('TaxEvaluationTime'));
export type TaxEvaluationTime = typeof TaxEvaluationTimeSchema.Type;

/** Commerce-owned Order Commitment Time T captured once for the exact frozen submission (#941 F2, #907 F155). */
export const OrderCommitmentTimeSchema = Schema.DateTimeUtcFromString.pipe(Schema.brand('OrderCommitmentTime'));
export type OrderCommitmentTime = typeof OrderCommitmentTimeSchema.Type;

/**
 * Final Launch Order Tax-Relevant Time is exactly T. Tax Evaluation Time, client/request time, Pricing Quotation
 * time and DB completion time are not inputs, so none of them can replace T (#941 F2-F4, F10, F12; #927 F10;
 * #907 F156).
 */
export const finalLaunchOrderTaxRelevantTime = (orderCommitmentTime: OrderCommitmentTime): TaxRelevantTime =>
  TaxRelevantTimeSchema.make(orderCommitmentTime);

/** Effective Period `[effective_from, effective_to)`; an absent end is open-ended (#929 F4-F7, #941 F5). */
export const EffectivePeriodSchema = Schema.Struct({
  effectiveFrom: Schema.DateTimeUtcFromString,
  effectiveTo: Schema.optionalKey(Schema.DateTimeUtcFromString),
});
export type EffectivePeriod = typeof EffectivePeriodSchema.Type;

/**
 * Half-open Effective Period membership at a Tax-Relevant Time: a period starting at T contains T, one ending at
 * T does not, and a future period is not yet applicable (#941 F5, #929 F4-F10). Only Tax-Relevant Time is
 * accepted, never Tax Evaluation Time (#929 F11-F12).
 */
export const isWithinEffectivePeriod = (period: EffectivePeriod, taxRelevantTime: TaxRelevantTime): boolean =>
  DateTime.isGreaterThanOrEqualTo(taxRelevantTime, period.effectiveFrom) &&
  (period.effectiveTo === undefined || DateTime.isLessThan(taxRelevantTime, period.effectiveTo));
