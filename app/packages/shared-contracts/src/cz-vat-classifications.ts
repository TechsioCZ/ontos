import { Schema } from 'effect';

/**
 * The Czech VAT classifications a selling company's goods carry. Tax (`commerce.tax`) holds the rate of each one
 * as a dated Tax Rule of that company; a product names only its classification, never a rate.
 */
export const CZ_VAT_STANDARD = 'cz.vat.standard';
export const CZ_VAT_REDUCED = 'cz.vat.reduced';

/** Every classification, in display order (standard first). */
export const czVatClassificationCodes = [CZ_VAT_STANDARD, CZ_VAT_REDUCED] as const;

export const CzVatClassificationCodeSchema = Schema.Literals(czVatClassificationCodes);
export type CzVatClassificationCode = typeof CzVatClassificationCodeSchema.Type;

/**
 * One dated rate of a classification as Tax publishes it for the selling company: the half-open period
 * `[effectiveFrom, effectiveTo)`, open-ended when `effectiveTo` is absent. A rate scheduled for the future is
 * its own entry with a future `effectiveFrom`.
 */
export const TaxRateViewSchema = Schema.Struct({
  code: CzVatClassificationCodeSchema,
  effectiveFrom: Schema.DateTimeUtcFromString,
  effectiveTo: Schema.optionalKey(Schema.DateTimeUtcFromString),
  ratePercent: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
});
export type TaxRateView = typeof TaxRateViewSchema.Type;
export type TaxRateViewEncoded = typeof TaxRateViewSchema.Encoded;
