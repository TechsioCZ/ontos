import { Array as Arr, Option, Schema, pipe } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import type { TaxDecision, TaxDecisionUnit, TaxableBasisInterpretation } from './tax-decision.ts';
import { RevisionSchema } from './tax-domain-primitives.ts';
import {
  TaxExactRationalSchema,
  divideTaxExactRationals,
  multiplyTaxExactRationals,
  roundNonNegativeHalfUpToMinorUnits,
  subtractTaxExactRationals,
  sumTaxExactRationals,
  taxExactRationalFromDecimal,
  taxExactRationalFromMinorUnits,
  taxExactRationalsEqual,
} from './tax-exact-rational.ts';
import type { TaxExactRational } from './tax-exact-rational.ts';
import {
  CZK_MINOR_UNITS_PER_MAJOR_UNIT,
  TaxCurrencySchema,
  TaxMonetaryAmountSchema,
  taxMonetaryAmountFromMinorUnits,
  taxMonetaryAmountMinorUnits,
} from './tax-monetary-amount.ts';
import type { TaxMonetaryAmount } from './tax-monetary-amount.ts';
import type { TaxableTreatment } from './tax-treatment.ts';
import { TaxableSupplyUnitIdSchema } from './taxable-supply-unit.ts';
import type { TaxableSupplyUnitId } from './taxable-supply-unit.ts';

const ONE_HUNDRED_PERCENT: TaxExactRational = { denominator: '1', numerator: '100' };

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

const publishedAmountOf = (exactTaxContribution: TaxExactRational): Option.Option<TaxMonetaryAmount> =>
  pipe(
    roundNonNegativeHalfUpToMinorUnits(exactTaxContribution, CZK_MINOR_UNITS_PER_MAJOR_UNIT),
    Option.flatMap(taxMonetaryAmountFromMinorUnits),
  );

const exactValueOf = (amount: TaxMonetaryAmount): TaxExactRational =>
  taxExactRationalFromMinorUnits(taxMonetaryAmountMinorUnits(amount), CZK_MINOR_UNITS_PER_MAJOR_UNIT);

/**
 * Tax rounding evidence of one Taxable Supply Unit: the exact pre-round contribution, the published amount at the
 * single final boundary and `Tax rounding adjustment = published tax - exact tax`. The adjustment is Tax-owned
 * evidence only; it changes no basis, Pricing amount or other unit (#935 F25, F35-F44; #907 F106).
 */
export const TaxUnitRoundingEvidenceSchema = Schema.Struct({
  exactTaxContribution: TaxExactRationalSchema,
  publishedTaxAmount: TaxMonetaryAmountSchema,
  taxableSupplyUnitId: TaxableSupplyUnitIdSchema,
  taxRoundingAdjustment: TaxExactRationalSchema,
  taxRoundingPolicy: TaxRoundingPolicySchema,
}).check(
  Schema.makeFilter(
    ({ exactTaxContribution, publishedTaxAmount }) =>
      Option.match(publishedAmountOf(exactTaxContribution), {
        onNone: () => false,
        onSome: ({ amount }) => amount === publishedTaxAmount.amount,
      }) || 'The published unit Tax amount must be ROUND_HALF_UP of the exact contribution at 0.01 CZK',
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

/**
 * Exact Tax contribution of one unit: its exact Taxable Basis (all components summed without any rounding) times
 * its exact rate (#935 F12-F19, F53; #907 F97). A rate that is not an exact decimal has no contribution.
 */
export const exactTaxContribution = (
  basis: TaxableBasisInterpretation,
  treatment: TaxableTreatment,
): Option.Option<TaxExactRational> =>
  pipe(
    taxExactRationalFromDecimal(treatment.ratePercent),
    Option.flatMap((ratePercent) => divideTaxExactRationals(ratePercent, ONE_HUNDRED_PERCENT)),
    Option.map((rate) =>
      multiplyTaxExactRationals(
        sumTaxExactRationals(
          pipe(
            basis.components,
            Arr.map(({ amount }) => amount),
          ),
        ),
        rate,
      ),
    ),
  );

/**
 * Applies the final Tax rounding boundary to the exact contribution of one Taxable Supply Unit (#935 F18-F25,
 * F35-F36, F53-F55; #907 F98-F100, F106). A negative exact contribution has no published Launch sale Tax amount.
 */
export const finalizeTaxContribution = (
  taxableSupplyUnitId: TaxableSupplyUnitId,
  exact: TaxExactRational,
  policy: TaxRoundingPolicy,
): Option.Option<TaxUnitRoundingEvidence> =>
  pipe(
    publishedAmountOf(exact),
    Option.map((publishedTaxAmount) => ({
      exactTaxContribution: exact,
      publishedTaxAmount,
      taxableSupplyUnitId,
      taxRoundingAdjustment: subtractTaxExactRationals(exactValueOf(publishedTaxAmount), exact),
      taxRoundingPolicy: policy,
    })),
  );

/** Calculates and finalizes one Taxable Supply Unit exactly once (#935 F7, F12, F18, F20; #907 F97-F98). */
export const finalizeTaxableSupplyUnitTax = (
  unit: TaxDecisionUnit,
  policy: TaxRoundingPolicy,
): Option.Option<TaxUnitRoundingEvidence> =>
  pipe(
    exactTaxContribution(unit.taxableBasisInterpretation, unit.treatment),
    Option.flatMap((exact) => finalizeTaxContribution(unit.taxableSupplyUnit.unitId, exact, policy)),
  );

/**
 * Finalizes every unit of a Decision independently, even with equal rates or values; units are never merged into a
 * rate bucket or rounding group (#935 F20, F26, F31-F34; #907 F73, F98).
 */
export const finalizeTaxDecisionUnits = (
  decision: TaxDecision,
  policy: TaxRoundingPolicy,
): Option.Option<NonEmptyReadonlyArray<TaxUnitRoundingEvidence>> =>
  Option.all(
    pipe(
      decision.units,
      Arr.map((unit) => finalizeTaxableSupplyUnitTax(unit, policy)),
    ),
  );
