import { Array as Arr, pipe } from 'effect';

import type { TaxDecision } from '../../shared/domain/tax-kernel/tax-decision.ts';
import { taxExactRationalsEqual } from '../../shared/domain/tax-kernel/tax-exact-rational.ts';
import { sumTaxMonetaryAmounts } from '../../shared/domain/tax-kernel/tax-monetary-amount.ts';
import { finalizeTaxDecisionUnits } from './tax-rounding.ts';
import type { TaxRoundingPolicy, TaxUnitRoundingEvidence } from './tax-rounding.ts';
import type { TaxResult } from '../../shared/domain/tax-kernel/tax-result.ts';

export { TaxResultSchema } from '../../shared/domain/tax-kernel/tax-result.ts';
export type { TaxResult } from '../../shared/domain/tax-kernel/tax-result.ts';

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
