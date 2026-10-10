import { Schema } from 'effect';

import { TaxDecisionSchema } from './tax-decision.ts';
import { TaxNonSuccessOutcomeSchema } from './tax-non-success-outcome.ts';
import { TaxResultSchema } from './tax-result.ts';
import type { TaxResult } from './tax-result.ts';
import type { TaxDecision } from './tax-decision.ts';

/**
 * The Result is bound to its Decision: same Decision identity, currency and exact Taxable Supply Unit set, joined by
 * unit identity, never by position (#936 F28-F29, #937 F7). Whether its amounts follow from the Decision is a Tax
 * calculation that only TAX performs (`taxResultFollowsFromDecision`), so it is not part of the published contract.
 */
const taxResultBindsToDecision = (decision: TaxDecision, result: TaxResult): boolean => {
  const unitIds = new Set<string>(decision.units.map(({ taxableSupplyUnit }) => taxableSupplyUnit.unitId));
  return (
    result.taxDecisionId === decision.decisionId &&
    result.currency === decision.purchaseBinding.currency &&
    result.units.length === unitIds.size &&
    result.units.every(({ taxableSupplyUnitId }) => unitIds.has(taxableSupplyUnitId))
  );
};

/**
 * Successful Tax Outcome: one purchase-scoped Tax Decision with its exactly bound Tax Result (#936 F7, F19-F20,
 * F27-F28, F32; #938 F1; #907 F132). A successful zero is valid only here, explained by its Decision (#936 F27,
 * #939 F2).
 */
export const TaxOutcomeSuccessSchema = Schema.TaggedStruct('TAX_DETERMINED', {
  decision: TaxDecisionSchema,
  result: TaxResultSchema,
}).check(
  Schema.makeFilter(
    ({ decision, result }) =>
      taxResultBindsToDecision(decision, result) || 'Tax Result must be exactly bound to its Tax Decision',
  ),
);

/**
 * Published Tax Outcome: a bound successful Decision + Result, or exactly one typed non-success meaning (#938 A,
 * F1-F2). TAX's own `src/domain/tax-outcome.ts` additionally checks that the amounts follow from the Decision.
 */
export const TaxOutcomeSchema = Schema.Union([TaxOutcomeSuccessSchema, TaxNonSuccessOutcomeSchema]);
