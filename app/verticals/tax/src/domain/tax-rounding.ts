import { Array as Arr, Match, pipe } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import type {
  TaxDecision,
  TaxDecisionUnit,
  TaxableBasisInterpretation,
} from '../../shared/domain/tax-kernel/tax-decision.ts';
import {
  NonNegativeTaxExactRationalSchema,
  ZERO_TAX_EXACT_RATIONAL,
  multiplyTaxExactRationals,
  subtractTaxExactRationals,
  sumTaxExactRationals,
  taxExactFractionOfPercent,
} from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import type { NonNegativeTaxExactRational } from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import { publishedTaxAmountRoundedHalfUp } from '../../shared/domain/tax-kernel/tax-monetary-amount.ts';
import type { TaxDecisionTreatment } from './tax-treatment.ts';
import { exactValueOf } from '../../shared/domain/tax-kernel/tax-rounding.ts';
import type { TaxRoundingPolicy, TaxUnitRoundingEvidence } from '../../shared/domain/tax-kernel/tax-rounding.ts';

export { TaxRoundingPolicySchema, TaxUnitRoundingEvidenceSchema } from '../../shared/domain/tax-kernel/tax-rounding.ts';
export type { TaxRoundingPolicy, TaxUnitRoundingEvidence } from '../../shared/domain/tax-kernel/tax-rounding.ts';

/** Launch CZ Tax Rounding policy revision 1: 0.01 CZK, ROUND_HALF_UP, once per Taxable Supply Unit (#935 F20-F24). */
export const LAUNCH_CZK_TAX_ROUNDING_POLICY: TaxRoundingPolicy = {
  currency: 'CZK',
  mode: 'ROUND_HALF_UP',
  precision: '0.01',
  revision: 1,
};

/**
 * Exact Tax contribution of one unit: its exact non-negative Taxable Basis (all components summed without any
 * rounding) times its exact positive rate, so it is non-negative (#935 F12-F19, F53; #907 F97).
 */
export const exactTaxContribution = (
  basis: TaxableBasisInterpretation,
  treatment: TaxDecisionTreatment,
): NonNegativeTaxExactRational =>
  NonNegativeTaxExactRationalSchema.make(
    Match.value(treatment).pipe(
      Match.tag('SELLER_NOT_VAT_PAYER', () => ZERO_TAX_EXACT_RATIONAL),
      Match.tag('TAXABLE', ({ ratePercent }) =>
        multiplyTaxExactRationals(
          sumTaxExactRationals(
            pipe(
              basis.components,
              Arr.map(({ amount }) => amount),
            ),
          ),
          taxExactFractionOfPercent(ratePercent),
        ),
      ),
      Match.exhaustive,
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
