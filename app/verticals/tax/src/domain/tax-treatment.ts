import { Match, Result, Schema } from 'effect';

import { PositiveDecimalStringSchema } from './tax-domain-primitives.ts';
import type { TaxCaseUnsupported, TaxUnsupportedRequirement } from './tax-non-success-outcome.ts';

/**
 * Tax Treatment language. Zero-rate, exemption and tax-not-applicable exist as explicit meanings but are
 * not activated by Launch (#939 F7-F9, F26-F28; #918 F22-F23).
 */
export const TaxTreatmentCategorySchema = Schema.Literals(['TAXABLE', 'ZERO_RATE', 'EXEMPTION', 'NOT_APPLICABLE']);
export type TaxTreatmentCategory = typeof TaxTreatmentCategorySchema.Type;

/** Launch-activated treatment categories (#918 F2-F3, #939 J). */
export const LaunchActivatedTaxTreatmentCategorySchema = Schema.Literal('TAXABLE');
export type LaunchActivatedTaxTreatmentCategory = typeof LaunchActivatedTaxTreatmentCategorySchema.Type;

/** Exact positive percentage rate; a missing rate is never 0 % (#939 F30, #918 F24). */
export const TaxRatePercentSchema = PositiveDecimalStringSchema;

/**
 * Launch-activated ordinary domestic taxable treatment with its rate. A taxable zero amount does not turn
 * it into zero-rate, exemption or not-applicable (#939 F3-F7).
 */
export const TaxableTreatmentSchema = Schema.TaggedStruct('TAXABLE', {
  ratePercent: TaxRatePercentSchema,
});
export type TaxableTreatment = typeof TaxableTreatmentSchema.Type;

/** Tax applicability meaning. Launch Decisions are explicitly applicable; absence is never not-applicable (#939 F9). */
export const TaxApplicabilitySchema = Schema.Literal('APPLICABLE');

const unsupportedRequirementByCategory = {
  EXEMPTION: 'EXEMPTION_TREATMENT',
  NOT_APPLICABLE: 'NOT_APPLICABLE_TREATMENT',
  ZERO_RATE: 'ZERO_RATE_TREATMENT',
} as const satisfies Record<
  Exclude<TaxTreatmentCategory, LaunchActivatedTaxTreatmentCategory>,
  TaxUnsupportedRequirement
>;

/** Requiring a treatment that Launch has not activated is TAX_CASE_UNSUPPORTED, never a fabricated zero (#939 F29). */
export const requireLaunchActivatedTaxTreatment = (
  required: TaxTreatmentCategory,
): Result.Result<LaunchActivatedTaxTreatmentCategory, TaxCaseUnsupported> =>
  Match.value(required).pipe(
    Match.when('TAXABLE', (category) => Result.succeed(category)),
    Match.orElse((category) =>
      Result.fail({
        _tag: 'TAX_CASE_UNSUPPORTED' as const,
        unsupportedRequirement: unsupportedRequirementByCategory[category],
      }),
    ),
  );
