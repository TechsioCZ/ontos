import { DateTime, Schema } from 'effect';

/**
 * The Czech VAT classifications a selling company's goods carry. The tax module holds the rate of each one as a
 * dated tax rule of that company; a product names only its classification, never a rate.
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

/** The VAT regime of the selling company in Tax; `null` when none is declared. */
export const SellerVatRegimeSchema = Schema.NullOr(Schema.Literals(['VAT_PAYER', 'NON_PAYER']));
export type SellerVatRegime = typeof SellerVatRegimeSchema.Type;

/** What a staff read carries about the selling company's VAT: its regime and its dated rates. */
export interface SellerVatRates {
  readonly sellerVatRegime?: SellerVatRegime | undefined;
  readonly taxRates?: readonly TaxRateView[] | undefined;
}

/**
 * The VAT rate goods of a classification are sold at, at an instant, by the one rule every package shares: a non-payer
 * sells everything at 0 %; a payer at the integer rate in force for the classification. `undefined` means the goods
 * cannot be sold: no regime declared, no classification, or no whole-number rate in force for it at that instant.
 */
export const vatRateAt = (
  seller: SellerVatRates,
  code: CzVatClassificationCode | undefined,
  at: DateTime.Utc,
): number | undefined => {
  if (seller.sellerVatRegime === 'NON_PAYER') {
    return 0;
  }
  if (seller.sellerVatRegime !== 'VAT_PAYER' || code === undefined) {
    return undefined;
  }
  const rate = (seller.taxRates ?? []).find(
    (entry) =>
      entry.code === code &&
      !DateTime.isLessThan(at, entry.effectiveFrom) &&
      (entry.effectiveTo === undefined || DateTime.isLessThan(at, entry.effectiveTo)),
  )?.ratePercent;
  return rate !== undefined && Number.isInteger(rate) ? rate : undefined;
};
