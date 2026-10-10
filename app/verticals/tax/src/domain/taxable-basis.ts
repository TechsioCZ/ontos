import { Result } from 'effect';

import type { PurchaseDemandOccurrenceId } from '../../shared/domain/tax-kernel/purchase-binding.ts';
import type { TaxCaseUnsupported, TaxStateIndeterminate } from './tax-non-success-outcome.ts';
import type { LineTaxableBasis, PublishedPricingLine } from '../../shared/domain/tax-kernel/taxable-basis.ts';

export {
  LineCommercialValueBasisSchema,
  PublishedPricingLineSchema,
} from '../../shared/domain/tax-kernel/taxable-basis.ts';
export type { LineTaxableBasis, PublishedPricingLine } from '../../shared/domain/tax-kernel/taxable-basis.ts';

/**
 * Composes the Taxable Basis input of one published Pricing Line. Discounts, Promotion allocations and Pricing
 * Commercial Fees are already inside the published value and are never added or subtracted again; no fee label
 * creates a separate supply or treatment (#931 F3-F11, #932 F1-F17, F22). A non-CZK amount is never relabelled
 * or converted and is outside Launch currency scope (#931 F15-F16, #918 F31-F33).
 */
export const composeLineTaxableBasis = (
  line: PublishedPricingLine,
): Result.Result<LineTaxableBasis, TaxCaseUnsupported> =>
  line.lineCommercialValue.currency === 'CZK'
    ? Result.succeed({
        basisComponent: {
          _tag: 'LINE_COMMERCIAL_VALUE',
          amount: line.lineCommercialValue.amount,
          occurrenceId: line.occurrenceId,
          pricingLineRef: line.pricingLineRef,
        },
        pricingBreakdownEvidence: line.breakdown,
      })
    : Result.fail({ _tag: 'TAX_CASE_UNSUPPORTED', unsupportedRequirement: 'NON_CZK_CURRENCY' });

/**
 * Taxable Basis input of one occurrence from the exact Pricing Result lines. A missing or ambiguous published
 * amount is never estimated, so it gives a typed non-success instead of a basis (#931 F14, F17; #938 F27-F28).
 */
export const lineTaxableBasisForOccurrence = (
  publishedPricingLines: readonly PublishedPricingLine[],
  occurrenceId: PurchaseDemandOccurrenceId,
): Result.Result<LineTaxableBasis, TaxCaseUnsupported | TaxStateIndeterminate> => {
  const lines = publishedPricingLines.filter((line) => line.occurrenceId === occurrenceId);
  const [line] = lines;
  return line !== undefined && lines.length === 1
    ? composeLineTaxableBasis(line)
    : Result.fail({ _tag: 'TAX_STATE_INDETERMINATE' });
};
