import { Match, Result } from 'effect';

import type { TaxCaseUnsupported, TaxUnsupportedRequirement } from './tax-non-success-outcome.ts';
import type { TaxTreatmentCategory } from '../../shared/domain/tax-kernel/tax-treatment.ts';

export {
  SellerNotVatPayerTreatmentSchema,
  TaxRatePercentSchema,
  TaxableTreatmentSchema,
} from '../../shared/domain/tax-kernel/tax-treatment.ts';
export type { TaxDecisionTreatment, TaxTreatmentCategory } from '../../shared/domain/tax-kernel/tax-treatment.ts';

/** Launch-activated treatment categories (#918 F2-F3, #939 J). */
export type LaunchActivatedTaxTreatmentCategory = Extract<TaxTreatmentCategory, 'TAXABLE'>;

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
