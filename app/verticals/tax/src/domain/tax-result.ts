import { Array as Arr, Option, Schema, pipe } from 'effect';

import { TaxDecisionIdSchema } from './tax-decision.ts';
import type { TaxDecision } from './tax-decision.ts';
import { distinctBy } from './tax-domain-primitives.ts';
import { TaxCurrencySchema, TaxMonetaryAmountSchema, sumTaxMonetaryAmounts } from './tax-monetary-amount.ts';
import { TaxRoundingPolicySchema, finalizeTaxDecisionUnits } from './tax-rounding.ts';
import type { TaxRoundingPolicy } from './tax-rounding.ts';
import { TaxableSupplyUnitIdSchema } from './taxable-supply-unit.ts';

/** Authoritative published Tax amount bound to its exact Taxable Supply Unit (#936 F28-F30, F34). */
export const TaxResultUnitSchema = Schema.Struct({
  publishedTaxAmount: TaxMonetaryAmountSchema,
  taxableSupplyUnitId: TaxableSupplyUnitIdSchema,
});
export type TaxResultUnit = typeof TaxResultUnitSchema.Type;

/**
 * Purchase-scoped Tax Result of one successful Tax Decision: explicit currency, one published amount per unit, a
 * purchase Tax total equal to their exact sum, never rounded again, and the Tax Rounding policy revision that
 * published them (#936 F20, F28-F40, F56; #935 F27-F30, F56).
 */
export const TaxResultSchema = Schema.Struct({
  currency: TaxCurrencySchema,
  purchaseTaxTotal: TaxMonetaryAmountSchema,
  taxDecisionId: TaxDecisionIdSchema,
  taxRoundingPolicy: TaxRoundingPolicySchema,
  units: Schema.NonEmptyArray(TaxResultUnitSchema).check(
    distinctBy(
      ({ taxableSupplyUnitId }: TaxResultUnit) => taxableSupplyUnitId,
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
 * (#935 F20, F27-F30, F56); this function only binds and sums the published amounts (#936 F28, F32, F35-F38). A
 * unit without a published amount gives no Result.
 */
export const composeTaxResult = (decision: TaxDecision, policy: TaxRoundingPolicy): Option.Option<TaxResult> =>
  pipe(
    finalizeTaxDecisionUnits(decision, policy),
    Option.map((evidence) => {
      const units = pipe(
        evidence,
        Arr.map(({ publishedTaxAmount, taxableSupplyUnitId }): TaxResultUnit => ({
          publishedTaxAmount,
          taxableSupplyUnitId,
        })),
      );
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
    }),
  );

/** Exact Decision <-> Result binding: same Decision identity and same exact unit set (#936 F28-F29). */
export const taxResultBindsDecision = (decision: TaxDecision, result: TaxResult): boolean => {
  const decisionUnitIds = new Set<string>(decision.units.map(({ taxableSupplyUnit }) => taxableSupplyUnit.unitId));
  return (
    result.taxDecisionId === decision.decisionId &&
    result.currency === decision.purchaseBinding.currency &&
    result.units.length === decisionUnitIds.size &&
    result.units.every(({ taxableSupplyUnitId }) => decisionUnitIds.has(taxableSupplyUnitId))
  );
};
