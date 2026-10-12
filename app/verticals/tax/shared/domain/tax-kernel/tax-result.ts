import { Array as Arr, Schema, pipe } from 'effect';

import { TaxDecisionIdSchema } from './tax-decision.ts';
import { distinctBy } from './tax-domain-primitives.ts';
import { TaxCurrencySchema, TaxMonetaryAmountSchema, sumTaxMonetaryAmounts } from './tax-monetary-amount.ts';
import { TaxRoundingPolicySchema, TaxUnitRoundingEvidenceSchema } from './tax-rounding.ts';
import type { TaxUnitRoundingEvidence } from './tax-rounding.ts';

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
