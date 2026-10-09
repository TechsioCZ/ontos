import { Schema } from 'effect';

import { PurchaseDemandOccurrenceIdSchema } from './purchase-binding.ts';
import { BoundedIdentifierSchema, CurrencyCodeSchema } from './tax-domain-primitives.ts';
import { NonNegativeTaxExactRationalSchema, TaxExactRationalSchema } from './tax-exact-rational.ts';

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
