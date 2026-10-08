import { Schema } from 'effect';

import { TaxDecisionSchema } from './tax-decision.ts';
import { TaxNonSuccessOutcomeSchema } from './tax-non-success-outcome.ts';
import { TaxResultSchema, taxResultBindsDecision } from './tax-result.ts';

/**
 * Successful Tax Outcome: one purchase-scoped Tax Decision with its exactly bound Tax Result (#936 F7, F20, F28;
 * #938 F1). A successful zero is valid only here, explained by its Decision (#936 F27, #939 F2).
 */
export const TaxOutcomeSuccessSchema = Schema.TaggedStruct('TAX_DETERMINED', {
  decision: TaxDecisionSchema,
  result: TaxResultSchema,
}).check(
  Schema.makeFilter(
    ({ decision, result }) =>
      taxResultBindsDecision(decision, result) || 'Tax Result must be exactly bound to its Tax Decision',
  ),
);
export type TaxOutcomeSuccess = typeof TaxOutcomeSuccessSchema.Type;

/** Tax Outcome: successful Decision + Result, or exactly one typed non-success meaning (#938 A, F1-F2). */
export const TaxOutcomeSchema = Schema.Union([TaxOutcomeSuccessSchema, TaxNonSuccessOutcomeSchema]);
export type TaxOutcome = typeof TaxOutcomeSchema.Type;
