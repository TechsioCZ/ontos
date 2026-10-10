import { Schema } from 'effect';

import { TaxDecisionSchema } from './tax-decision.ts';
import { TaxNonSuccessOutcomeSchema } from './tax-non-success-outcome.ts';
import { TaxResultSchema, taxResultFollowsFromDecision } from './tax-result.ts';

/**
 * Successful Tax Outcome: one purchase-scoped Tax Decision with its exactly bound Tax Result whose amounts follow
 * from that Decision (#936 F7, F19-F20, F27-F28, F32; #938 F1; #907 F132). A successful zero is valid only here,
 * explained by its Decision (#936 F27, #939 F2).
 */
export const TaxOutcomeSuccessSchema = Schema.TaggedStruct('TAX_DETERMINED', {
  decision: TaxDecisionSchema,
  result: TaxResultSchema,
}).check(
  Schema.makeFilter(
    ({ decision, result }) =>
      taxResultFollowsFromDecision(decision, result) ||
      'Tax Result must be exactly bound to its Tax Decision and follow from it',
  ),
);
export type TaxOutcomeSuccess = typeof TaxOutcomeSuccessSchema.Type;

/** Tax Outcome: successful Decision + Result, or exactly one typed non-success meaning (#938 A, F1-F2). */
export const TaxOutcomeSchema = Schema.Union([TaxOutcomeSuccessSchema, TaxNonSuccessOutcomeSchema]);
export type TaxOutcome = typeof TaxOutcomeSchema.Type;
