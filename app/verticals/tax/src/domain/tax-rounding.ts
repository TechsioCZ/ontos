import { Array as Arr, Match, Option, pipe } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import type {
  TaxDecision,
  TaxDecisionUnit,
  TaxableBasisInterpretation,
} from '../../shared/domain/tax-kernel/tax-decision.ts';
import {
  NonNegativeTaxExactRationalSchema,
  ONE_TAX_EXACT_RATIONAL,
  ZERO_TAX_EXACT_RATIONAL,
  addTaxExactRationals,
  divideTaxExactRationals,
  multiplyTaxExactRationals,
  subtractTaxExactRationals,
  sumTaxExactRationals,
  taxExactFractionOfPercent,
} from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import type {
  NonNegativeTaxExactRational,
  TaxExactRational,
} from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import type { TaxAmountBasis } from '../../shared/domain/tax-kernel/taxable-basis.ts';
import { publishedTaxAmountRoundedHalfUp } from '../../shared/domain/tax-kernel/tax-monetary-amount.ts';
import type { TaxDecisionTreatment } from './tax-treatment.ts';
import { exactValueOf } from '../../shared/domain/tax-kernel/tax-rounding.ts';
import type { TaxRoundingPolicy, TaxUnitRoundingEvidence } from '../../shared/domain/tax-kernel/tax-rounding.ts';

/**
 * Exact § 37 písm. b) VAT of one amount at the given rate, respecting its explicit amount basis (PO decision D3 on
 * #907). GROSS carves VAT out of the customer-charged amount: `amount * r / (1 + r)`. NET multiplies the pre-Tax
 * base by the rate, unchanged from before D3. `1 + r` is always positive for a valid rate, so the division is
 * always exact; `Option.getOrThrow` cannot fail. Module-private: every caller goes through `exactTaxOfAmounts`.
 */
const exactVatOfAmount = (
  amount: NonNegativeTaxExactRational,
  amountBasis: TaxAmountBasis,
  rate: TaxExactRational,
): TaxExactRational =>
  amountBasis === 'NET'
    ? multiplyTaxExactRationals(amount, rate)
    : Option.getOrThrow(
        divideTaxExactRationals(
          multiplyTaxExactRationals(amount, rate),
          addTaxExactRationals(ONE_TAX_EXACT_RATIONAL, rate),
        ),
      );

/**
 * Exact § 37 písm. b) VAT of a set of (amount, amount basis) pairs under one Tax Decision treatment: a non-payer
 * owes none; a taxable treatment sums the exact VAT of each pair at its own recorded amount basis. This is the one
 * exact-tax function shared by Tax Decision contribution and Tax Correction arithmetic, so a later change to
 * `exactVatOfAmount` reaches both automatically (Unit 12 B1).
 */
export const exactTaxOfAmounts = (
  amounts: NonEmptyReadonlyArray<{
    readonly amount: NonNegativeTaxExactRational;
    readonly amountBasis: TaxAmountBasis;
  }>,
  treatment: TaxDecisionTreatment,
): NonNegativeTaxExactRational =>
  NonNegativeTaxExactRationalSchema.make(
    Match.value(treatment).pipe(
      Match.tag('SELLER_NOT_VAT_PAYER', () => ZERO_TAX_EXACT_RATIONAL),
      Match.tag('TAXABLE', ({ ratePercent }) => {
        const rate = taxExactFractionOfPercent(ratePercent);
        return sumTaxExactRationals(
          pipe(
            amounts,
            Arr.map(({ amount, amountBasis }) => exactVatOfAmount(amount, amountBasis, rate)),
          ),
        );
      }),
      Match.exhaustive,
    ),
  );

/**
 * Converts an exact amount between GROSS and NET under one Tax Decision treatment, at the original unit's own rate.
 * Identity when the bases already match or the seller is not a VAT payer (no VAT in a non-payer consideration).
 * Signed input is fine, so a negative correction delta converts the same way as a positive amount. `1 + r` is
 * always positive for a valid rate, so `Option.getOrThrow` on the GROSS → NET division cannot fail (Unit 11 rule).
 */
export const amountInBasis = (
  amount: TaxExactRational,
  from: TaxAmountBasis,
  to: TaxAmountBasis,
  treatment: TaxDecisionTreatment,
): TaxExactRational =>
  Match.value(treatment).pipe(
    Match.tag('SELLER_NOT_VAT_PAYER', () => amount),
    Match.tag('TAXABLE', ({ ratePercent }) => {
      if (from === to) {
        return amount;
      }
      const rate = taxExactFractionOfPercent(ratePercent);
      return from === 'GROSS'
        ? Option.getOrThrow(divideTaxExactRationals(amount, addTaxExactRationals(ONE_TAX_EXACT_RATIONAL, rate)))
        : multiplyTaxExactRationals(amount, addTaxExactRationals(ONE_TAX_EXACT_RATIONAL, rate));
    }),
    Match.exhaustive,
  );

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
 * Exact Tax contribution of one unit: the sum, without any rounding, of the exact § 37 písm. b) VAT of each
 * Taxable Basis component at its own recorded amount basis (goods, quantity and the exact shipping share), so it
 * is non-negative (#935 F12-F19, F53; #907 F97; PO decision D3 on #907).
 */
export const exactTaxContribution = (
  basis: TaxableBasisInterpretation,
  treatment: TaxDecisionTreatment,
): NonNegativeTaxExactRational => exactTaxOfAmounts(basis.components, treatment);

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
