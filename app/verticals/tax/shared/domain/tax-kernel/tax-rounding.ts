import { Schema } from 'effect';

import { RevisionSchema } from './tax-domain-primitives.ts';
import {
  NonNegativeTaxExactRationalSchema,
  TaxExactRationalSchema,
  subtractTaxExactRationals,
  taxExactRationalFromMinorUnits,
  taxExactRationalsEqual,
} from './tax-exact-rational.ts';
import type { TaxExactRational } from './tax-exact-rational.ts';
import {
  CZK_MINOR_UNITS_PER_MAJOR_UNIT,
  TaxCurrencySchema,
  TaxMonetaryAmountSchema,
  publishedTaxAmountRoundedHalfUp,
  taxMonetaryAmountMinorUnits,
} from './tax-monetary-amount.ts';
import type { TaxMonetaryAmount } from './tax-monetary-amount.ts';
import { TaxableSupplyUnitIdSchema } from './taxable-supply-unit.ts';

/**
 * Versioned Tax Rounding policy. Launch CZ publishes once per Taxable Supply Unit at 0.01 CZK with ROUND_HALF_UP,
 * an OntOS product policy separate from Pricing rounding; Accepted Tax Terms retain the revision used and another
 * currency needs its own policy (#935 F6, F20-F24, F56-F58; glossary Tax Rounding).
 */
export const TaxRoundingPolicySchema = Schema.Struct({
  currency: TaxCurrencySchema,
  mode: Schema.Literal('ROUND_HALF_UP'),
  precision: Schema.Literal('0.01'),
  revision: RevisionSchema,
});

export type TaxRoundingPolicy = typeof TaxRoundingPolicySchema.Type;

export const exactValueOf = (amount: TaxMonetaryAmount): TaxExactRational =>
  taxExactRationalFromMinorUnits(taxMonetaryAmountMinorUnits(amount), CZK_MINOR_UNITS_PER_MAJOR_UNIT);

/**
 * Tax rounding evidence of one Taxable Supply Unit: the exact pre-round contribution, the published amount at the
 * single final boundary and `Tax rounding adjustment = published tax - exact tax`. The adjustment is Tax-owned
 * evidence only; it changes no basis, Pricing amount or other unit (#935 F25, F35-F44; #907 F106).
 */
export const TaxUnitRoundingEvidenceSchema = Schema.Struct({
  exactTaxContribution: NonNegativeTaxExactRationalSchema,
  publishedTaxAmount: TaxMonetaryAmountSchema,
  taxableSupplyUnitId: TaxableSupplyUnitIdSchema,
  taxRoundingAdjustment: TaxExactRationalSchema,
  taxRoundingPolicy: TaxRoundingPolicySchema,
}).check(
  Schema.makeFilter(
    ({ exactTaxContribution, publishedTaxAmount }) =>
      publishedTaxAmountRoundedHalfUp(exactTaxContribution).amount === publishedTaxAmount.amount ||
      'The published unit Tax amount must be ROUND_HALF_UP of the exact contribution at 0.01 CZK',
  ),
  Schema.makeFilter(
    ({ exactTaxContribution, publishedTaxAmount, taxRoundingAdjustment }) =>
      taxExactRationalsEqual(
        taxRoundingAdjustment,
        subtractTaxExactRationals(exactValueOf(publishedTaxAmount), exactTaxContribution),
      ) || 'The Tax rounding adjustment must equal published Tax minus exact Tax',
  ),
);

export type TaxUnitRoundingEvidence = typeof TaxUnitRoundingEvidenceSchema.Type;
