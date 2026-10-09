import { Schema } from 'effect';

import { PositiveDecimalStringSchema } from './tax-domain-primitives.ts';

/**
 * Tax Treatment language. Zero-rate, exemption and tax-not-applicable exist as explicit meanings but are
 * not activated by Launch (#939 F7-F9, F26-F28; #918 F22-F23).
 */
export const TaxTreatmentCategorySchema = Schema.Literals(['TAXABLE', 'ZERO_RATE', 'EXEMPTION', 'NOT_APPLICABLE']);

export type TaxTreatmentCategory = typeof TaxTreatmentCategorySchema.Type;

/** Exact positive percentage rate; a missing rate is never 0 % (#939 F30, #918 F24). */
export const TaxRatePercentSchema = PositiveDecimalStringSchema;

/**
 * Launch-activated ordinary domestic taxable treatment with its rate. A taxable zero amount does not turn
 * it into zero-rate, exemption or not-applicable (#939 F3-F7).
 */
export const TaxableTreatmentSchema = Schema.TaggedStruct('TAXABLE', {
  ratePercent: TaxRatePercentSchema,
});

export type TaxableTreatment = typeof TaxableTreatmentSchema.Type;

/**
 * Seller-is-non-payer treatment: the seller's declared VAT Regime is NON_PAYER, so the supply carries no VAT line.
 * This is not ZERO_RATE, EXEMPTION or NOT_APPLICABLE; it is a distinct meaning keyed to the seller's regime, not to
 * the supply's own classification (Unit 10 A2, LEGAL §1).
 */
export const SellerNotVatPayerTreatmentSchema = Schema.TaggedStruct('SELLER_NOT_VAT_PAYER', {});

export type SellerNotVatPayerTreatment = typeof SellerNotVatPayerTreatmentSchema.Type;

/** Every Tax Decision unit treatment: taxable with a rate, or seller-is-non-payer (Unit 10 A2). */
export const TaxDecisionTreatmentSchema = Schema.Union([TaxableTreatmentSchema, SellerNotVatPayerTreatmentSchema]);

export type TaxDecisionTreatment = typeof TaxDecisionTreatmentSchema.Type;

/** Tax applicability meaning. Launch Decisions are explicitly applicable; absence is never not-applicable (#939 F9). */
export const TaxApplicabilitySchema = Schema.Literal('APPLICABLE');
