import { Schema } from 'effect';

import { TaxOutcomeSuccessSchema as BoundTaxOutcomeSuccessSchema } from '../../shared/domain/tax-kernel/tax-outcome.ts';
import { TaxNonSuccessOutcomeSchema } from './tax-non-success-outcome.ts';
import { taxResultFollowsFromDecision } from './tax-result.ts';

/**
 * Successful Tax Outcome as TAX accepts it: the published bound Decision and Result whose amounts also follow from
 * that Decision (#936 F7, F19-F20, F27-F28, F32; #938 F1; #907 F132). The amount check is a Tax calculation and stays
 * owner-local; the published contract (`shared/domain/tax-kernel/tax-outcome.ts`) carries the binding only.
 */
export const TaxOutcomeSuccessSchema = BoundTaxOutcomeSuccessSchema.check(
  Schema.makeFilter(
    ({ decision, result }) =>
      taxResultFollowsFromDecision(decision, result) || 'Tax Result must follow from its Tax Decision',
  ),
);
export type TaxOutcomeSuccess = typeof TaxOutcomeSuccessSchema.Type;

/** Tax Outcome as TAX accepts it: a successful Decision + Result, or exactly one typed non-success meaning (#938 A). */
export const TaxOutcomeSchema = Schema.Union([TaxOutcomeSuccessSchema, TaxNonSuccessOutcomeSchema]);
export type TaxOutcome = typeof TaxOutcomeSchema.Type;
