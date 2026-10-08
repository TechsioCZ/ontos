import { Array as Arr, Schema, pipe } from 'effect';

import { TaxDecisionIdSchema } from './tax-decision.ts';
import type { TaxDecision } from './tax-decision.ts';
import { distinctBy } from './tax-domain-primitives.ts';
import { taxExactRationalsEqual } from './tax-exact-rational.ts';
import { TaxCurrencySchema, TaxMonetaryAmountSchema, sumTaxMonetaryAmounts } from './tax-monetary-amount.ts';
import { TaxRoundingPolicySchema, TaxUnitRoundingEvidenceSchema, finalizeTaxDecisionUnits } from './tax-rounding.ts';
import type { TaxRoundingPolicy, TaxUnitRoundingEvidence } from './tax-rounding.ts';

/**
 * Purchase-scoped Tax Result of one successful Tax Decision: explicit currency, one published amount per unit kept
 * with its Tax rounding evidence (exact contribution, adjustment, policy revision), a purchase Tax total equal to
 * their exact sum, never rounded again, and the Tax Rounding policy revision that published them (#936 F20,
 * F28-F40, F56; #935 F27-F30, F35-F36, F56; #907 F106).
 */
export const TaxResultSchema = Schema.Struct({
  currency: TaxCurrencySchema,
  purchaseTaxTotal: TaxMonetaryAmountSchema,
  taxDecisionId: TaxDecisionIdSchema,
  taxRoundingPolicy: TaxRoundingPolicySchema,
  units: Schema.NonEmptyArray(TaxUnitRoundingEvidenceSchema).check(
    distinctBy(
      ({ taxableSupplyUnitId }: TaxUnitRoundingEvidence) => taxableSupplyUnitId,
      'A Tax Result must not repeat a Taxable Supply Unit',
    ),
  ),
}).check(
  Schema.makeFilter(
    ({ purchaseTaxTotal, units }) =>
      sumTaxMonetaryAmounts(
        pipe(
          units,
          Arr.map(({ publishedTaxAmount }) => publishedTaxAmount),
        ),
      ).amount === purchaseTaxTotal.amount ||
      'Purchase Tax total must equal the exact sum of published unit Tax amounts',
  ),
);
export type TaxResult = typeof TaxResultSchema.Type;

/**
 * Composes the Tax Result for exactly the Decision's units from their Tax Rounding evidence under one policy
 * (#935 F20, F27-F30, F56); this function only binds and sums the published amounts (#936 F28, F32, F35-F38).
 */
export const composeTaxResult = (decision: TaxDecision, policy: TaxRoundingPolicy): TaxResult => {
  const units = finalizeTaxDecisionUnits(decision, policy);
  return {
    currency: decision.purchaseBinding.currency,
    purchaseTaxTotal: sumTaxMonetaryAmounts(
      pipe(
        units,
        Arr.map(({ publishedTaxAmount }) => publishedTaxAmount),
      ),
    ),
    taxDecisionId: decision.decisionId,
    taxRoundingPolicy: policy,
    units,
  };
};

const isSameUnitEvidence = (left: TaxUnitRoundingEvidence, right: TaxUnitRoundingEvidence): boolean =>
  left.taxableSupplyUnitId === right.taxableSupplyUnitId &&
  left.publishedTaxAmount.amount === right.publishedTaxAmount.amount &&
  taxExactRationalsEqual(left.exactTaxContribution, right.exactTaxContribution) &&
  taxExactRationalsEqual(left.taxRoundingAdjustment, right.taxRoundingAdjustment) &&
  left.taxRoundingPolicy.revision === right.taxRoundingPolicy.revision;

/**
 * The Result is bound to and follows from its Decision: same Decision identity, currency and exact unit set, and
 * every amount equals what the Decision composes under the Result's own rounding policy. Units are joined by their
 * Taxable Supply Unit identity, never by array position (#937 F7). A check, not a second source of truth (#936 F19,
 * F27-F29, F32; #939 F2; #907 F132).
 */
export const taxResultFollowsFromDecision = (decision: TaxDecision, result: TaxResult): boolean => {
  const expected = composeTaxResult(decision, result.taxRoundingPolicy);
  const expectedByUnitId = new Map<string, TaxUnitRoundingEvidence>(
    expected.units.map((unit) => [unit.taxableSupplyUnitId, unit]),
  );
  return (
    result.taxDecisionId === expected.taxDecisionId &&
    result.currency === expected.currency &&
    result.purchaseTaxTotal.amount === expected.purchaseTaxTotal.amount &&
    new Set(result.units.map(({ taxableSupplyUnitId }) => taxableSupplyUnitId)).size === expected.units.length &&
    result.units.length === expected.units.length &&
    result.units.every((unit) => {
      const expectedUnit = expectedByUnitId.get(unit.taxableSupplyUnitId);
      return expectedUnit !== undefined && isSameUnitEvidence(unit, expectedUnit);
    })
  );
};
