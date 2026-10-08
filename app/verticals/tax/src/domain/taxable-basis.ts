import { Result, Schema } from 'effect';

import { PurchaseDemandOccurrenceIdSchema } from './purchase-binding.ts';
import type { PurchaseDemandOccurrenceId } from './purchase-binding.ts';
import { BoundedIdentifierSchema, CurrencyCodeSchema } from './tax-domain-primitives.ts';
import { NonNegativeTaxExactRationalSchema, TaxExactRationalSchema } from './tax-exact-rational.ts';
import type { TaxCaseUnsupported, TaxStateIndeterminate } from './tax-non-success-outcome.ts';

/** Published Line Commercial Value of the Pricing Line for one source occurrence (#937 F27, #920 F19). */
export const LineCommercialValueBasisSchema = Schema.TaggedStruct('LINE_COMMERCIAL_VALUE', {
  amount: NonNegativeTaxExactRationalSchema,
  occurrenceId: PurchaseDemandOccurrenceIdSchema,
  pricingLineRef: BoundedIdentifierSchema,
});

/**
 * Exact owner-issued commercial amount as received by TAX, with explicit currency that TAX never relabels or
 * converts (#931 F14-F16, #933 F4-F5). TAX consumes it; ownership stays with its owner (#931 F1-F2, #933 F1-F4).
 */
export const OwnerIssuedAmountSchema = Schema.Struct({
  amount: NonNegativeTaxExactRationalSchema,
  currency: CurrencyCodeSchema,
});

/**
 * One contribution of the published Pricing breakdown (Price, Discount, Promotion allocation, Pricing Commercial Fee
 * such as RECYCLING_FEE or COPYRIGHT_FEE, ...). It explains the published value and is never a second monetary
 * source; its family label is not a Tax Classification (#931 F7-F11, #932 F5-F6, F13-F15).
 */
export const PricingContributionEvidenceSchema = Schema.Struct({
  amount: Schema.Struct({ amount: TaxExactRationalSchema, currency: CurrencyCodeSchema }),
  contributionFamily: BoundedIdentifierSchema,
  contributionRef: BoundedIdentifierSchema,
});

/** Authoritative published Pricing Line of one occurrence with its breakdown evidence (#931 F3-F4, #932 F4-F5). */
export const PublishedPricingLineSchema = Schema.Struct({
  breakdown: Schema.Array(PricingContributionEvidenceSchema),
  lineCommercialValue: OwnerIssuedAmountSchema,
  occurrenceId: PurchaseDemandOccurrenceIdSchema,
  pricingLineRef: BoundedIdentifierSchema,
});
export type PublishedPricingLine = typeof PublishedPricingLineSchema.Type;

/**
 * Taxable Basis input from one published Pricing Line: exactly the published Line Commercial Value, with the
 * breakdown retained only as evidence (#931 F3-F11, F17; #932 F1-F12, F23; #907 F77-F83, F87-F88).
 */
export const LineTaxableBasisSchema = Schema.Struct({
  basisComponent: LineCommercialValueBasisSchema,
  pricingBreakdownEvidence: Schema.Array(PricingContributionEvidenceSchema),
});
export type LineTaxableBasis = typeof LineTaxableBasisSchema.Type;

/**
 * Composes the Taxable Basis input of one published Pricing Line. Discounts, Promotion allocations and Pricing
 * Commercial Fees are already inside the published value and are never added or subtracted again; no fee label
 * creates a separate supply or treatment (#931 F3-F11, #932 F1-F17, F22). A non-CZK amount is never relabelled
 * or converted and is outside Launch currency scope (#931 F15-F16, #918 F31-F33).
 */
export const composeLineTaxableBasis = (
  line: PublishedPricingLine,
): Result.Result<LineTaxableBasis, TaxCaseUnsupported> =>
  line.lineCommercialValue.currency === 'CZK'
    ? Result.succeed({
        basisComponent: {
          _tag: 'LINE_COMMERCIAL_VALUE',
          amount: line.lineCommercialValue.amount,
          occurrenceId: line.occurrenceId,
          pricingLineRef: line.pricingLineRef,
        },
        pricingBreakdownEvidence: line.breakdown,
      })
    : Result.fail({ _tag: 'TAX_CASE_UNSUPPORTED', unsupportedRequirement: 'NON_CZK_CURRENCY' });

/**
 * Taxable Basis input of one occurrence from the exact Pricing Result lines. A missing or ambiguous published
 * amount is never estimated, so it gives a typed non-success instead of a basis (#931 F14, F17; #938 F27-F28).
 */
export const lineTaxableBasisForOccurrence = (
  publishedPricingLines: readonly PublishedPricingLine[],
  occurrenceId: PurchaseDemandOccurrenceId,
): Result.Result<LineTaxableBasis, TaxCaseUnsupported | TaxStateIndeterminate> => {
  const lines = publishedPricingLines.filter((line) => line.occurrenceId === occurrenceId);
  const [line] = lines;
  return line !== undefined && lines.length === 1
    ? composeLineTaxableBasis(line)
    : Result.fail({ _tag: 'TAX_STATE_INDETERMINATE' });
};
