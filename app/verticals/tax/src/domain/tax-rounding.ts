import { Array as Arr, Schema, pipe } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import type { TaxDecision, TaxDecisionUnit, TaxableBasisInterpretation } from './tax-decision.ts';
import { RevisionSchema } from './tax-domain-primitives.ts';
import {
  NonNegativeTaxExactRationalSchema,
  TaxExactRationalSchema,
  multiplyTaxExactRationals,
  subtractTaxExactRationals,
  sumTaxExactRationals,
  taxExactRationalFromMinorUnits,
  taxExactRationalsEqual,
} from './tax-exact-rational.ts';
import type { NonNegativeTaxExactRational, TaxExactRational } from './tax-exact-rational.ts';
import {
  CZK_MINOR_UNITS_PER_MAJOR_UNIT,
  TaxCurrencySchema,
  TaxMonetaryAmountSchema,
  publishedTaxAmountRoundedHalfUp,
  taxMonetaryAmountMinorUnits,
} from './tax-monetary-amount.ts';
import type { TaxMonetaryAmount } from './tax-monetary-amount.ts';
import type { TaxableTreatment } from './tax-treatment.ts';
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

const exactValueOf = (amount: TaxMonetaryAmount): TaxExactRational =>
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

/** Exact fraction of a schema-checked positive decimal rate percent, e.g. `21` is 21/100, read without floats. */
const exactRateFraction = ({ ratePercent }: TaxableTreatment): TaxExactRational => {
  const [integerDigits = '0', fractionDigits = ''] = ratePercent.split('.');
  return taxExactRationalFromMinorUnits(
    BigInt(`${integerDigits}${fractionDigits}`),
    100n * 10n ** BigInt(fractionDigits.length),
  );
};

/**
 * Exact Tax contribution of one unit: its exact non-negative Taxable Basis (all components summed without any
 * rounding) times its exact positive rate, so it is non-negative (#935 F12-F19, F53; #907 F97).
 */
export const exactTaxContribution = (
  basis: TaxableBasisInterpretation,
  treatment: TaxableTreatment,
): NonNegativeTaxExactRational =>
  NonNegativeTaxExactRationalSchema.make(
    multiplyTaxExactRationals(
      sumTaxExactRationals(
        pipe(
          basis.components,
          Arr.map(({ amount }) => amount),
        ),
      ),
      exactRateFraction(treatment),
    ),
  );

/**
 * Calculates one Taxable Supply Unit exactly once and applies the final Tax rounding boundary to its exact
 * contribution, keeping `published - exact` as Tax rounding evidence (#935 F7, F12, F18-F25, F35-F36, F53-F55;
 * #907 F97-F100, F106).
 */
export const finalizeTaxableSupplyUnitTax = (
  unit: TaxDecisionUnit,
  policy: TaxRoundingPolicy,
): TaxUnitRoundingEvidence => {
  const exact = exactTaxContribution(unit.taxableBasisInterpretation, unit.treatment);
  const publishedTaxAmount = publishedTaxAmountRoundedHalfUp(exact);
  return {
    exactTaxContribution: exact,
    publishedTaxAmount,
    taxableSupplyUnitId: unit.taxableSupplyUnit.unitId,
    taxRoundingAdjustment: subtractTaxExactRationals(exactValueOf(publishedTaxAmount), exact),
    taxRoundingPolicy: policy,
  };
};

/**
 * Finalizes every unit of a Decision independently, even with equal rates or values; units are never merged into a
 * rate bucket or rounding group (#935 F20, F26, F31-F34; #907 F73, F98).
 */
export const finalizeTaxDecisionUnits = (
  decision: TaxDecision,
  policy: TaxRoundingPolicy,
): NonEmptyReadonlyArray<TaxUnitRoundingEvidence> =>
  pipe(
    decision.units,
    Arr.map((unit) => finalizeTaxableSupplyUnitTax(unit, policy)),
  );
