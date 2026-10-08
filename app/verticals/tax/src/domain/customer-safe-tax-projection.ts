import { Array as Arr, Match, Option, Schema, pipe } from 'effect';
import type { NonEmptyReadonlyArray } from 'effect/Array';

import { PurchaseDemandOccurrenceIdSchema } from './purchase-binding.ts';
import { TaxMonetaryAmountSchema } from './tax-monetary-amount.ts';
import type { TaxMonetaryAmount } from './tax-monetary-amount.ts';
import type { TaxOutcome, TaxOutcomeSuccess } from './tax-outcome.ts';
import { taxResultBindsDecision } from './tax-result.ts';
import { TaxRatePercentSchema } from './tax-treatment.ts';
import { taxableSupplyUnitSourceOccurrenceIds } from './taxable-supply-unit.ts';

/** Customer-Safe Tax Projection contract version (#940 F44, glossary: versioned allowlist). */
export const CUSTOMER_SAFE_TAX_PROJECTION_VERSION = 1;

/** Whether the exact view needs several Tax components explained (#940 F23-F24). */
export const CustomerSafeTaxDecompositionNeedSchema = Schema.Literals(['NOT_NEEDED', 'PER_TAXABLE_SUPPLY_UNIT']);
export type CustomerSafeTaxDecompositionNeed = typeof CustomerSafeTaxDecompositionNeedSchema.Type;

/** Presentation-safe treatment/rate meaning; it never creates its own Tax decision (#940 F22, F31). */
const CustomerSafeTaxComponentSchema = Schema.Struct({
  purchaseDemandOccurrenceIds: Schema.NonEmptyArray(PurchaseDemandOccurrenceIdSchema),
  taxAmount: TaxMonetaryAmountSchema,
  treatment: Schema.Struct({ category: Schema.Literal('TAXABLE'), ratePercent: TaxRatePercentSchema }),
});

/**
 * Explicit allowlist: Tax amount with currency and, only when the view needs it, presentation-safe decomposition
 * (#940 F18-F24). No rule revision, source/provider, currentness, commitment or evidence identities (#940 F25-F30).
 */
export const CustomerSafeTaxAmountSchema = Schema.TaggedStruct('TAX_AMOUNT', {
  components: Schema.optionalKey(Schema.NonEmptyArray(CustomerSafeTaxComponentSchema)),
  contractVersion: Schema.Literal(CUSTOMER_SAFE_TAX_PROJECTION_VERSION),
  purchaseTaxTotal: TaxMonetaryAmountSchema,
});

/** A non-success outcome is projected without any Tax amount (#940 F38, #939 F34). */
export const CustomerSafeTaxNotDeterminedSchema = Schema.TaggedStruct('TAX_NOT_DETERMINED', {
  contractVersion: Schema.Literal(CUSTOMER_SAFE_TAX_PROJECTION_VERSION),
});

export const CustomerSafeTaxProjectionSchema = Schema.Union([
  CustomerSafeTaxAmountSchema,
  CustomerSafeTaxNotDeterminedSchema,
]);
export type CustomerSafeTaxProjection = typeof CustomerSafeTaxProjectionSchema.Type;

type CustomerSafeTaxComponent = typeof CustomerSafeTaxComponentSchema.Type;

/**
 * Joins each Decision unit with its published Result amount. A unit without its published amount is never dropped:
 * the whole decomposition is then absent (#940 F32).
 */
const componentsOf = (success: TaxOutcomeSuccess): Option.Option<NonEmptyReadonlyArray<CustomerSafeTaxComponent>> => {
  const amountByUnit = new Map<string, TaxMonetaryAmount>(
    success.result.units.map(({ publishedTaxAmount, taxableSupplyUnitId }) => [
      taxableSupplyUnitId,
      publishedTaxAmount,
    ]),
  );
  return Option.all(
    pipe(
      success.decision.units,
      Arr.map(({ taxableSupplyUnit, treatment }) =>
        pipe(
          Option.fromNullishOr(amountByUnit.get(taxableSupplyUnit.unitId)),
          Option.map((taxAmount): CustomerSafeTaxComponent => ({
            purchaseDemandOccurrenceIds: taxableSupplyUnitSourceOccurrenceIds(taxableSupplyUnit),
            taxAmount,
            treatment: { category: treatment._tag, ratePercent: treatment.ratePercent },
          })),
        ),
      ),
    ),
  );
};

/**
 * Projects one authoritative Tax Outcome into its customer-safe view by copying published values only; it never
 * recomputes Tax, rounds or balances (#940 F19, F32-F36, F44). A successful outcome whose Result is not exactly
 * bound to its Decision has no projection, so the customer view can never diverge from it (#940 F32, #936 F28-F29).
 */
export const projectCustomerSafeTax = (
  outcome: TaxOutcome,
  decompositionNeed: CustomerSafeTaxDecompositionNeed,
): Option.Option<CustomerSafeTaxProjection> =>
  Match.value(outcome).pipe(
    Match.tag('TAX_DETERMINED', (success): Option.Option<CustomerSafeTaxProjection> => {
      if (!taxResultBindsDecision(success.decision, success.result)) {
        return Option.none();
      }
      const projection = {
        _tag: 'TAX_AMOUNT',
        contractVersion: CUSTOMER_SAFE_TAX_PROJECTION_VERSION,
        purchaseTaxTotal: success.result.purchaseTaxTotal,
      } as const;
      return decompositionNeed === 'PER_TAXABLE_SUPPLY_UNIT'
        ? Option.map(componentsOf(success), (components) => ({ ...projection, components }))
        : Option.some(projection);
    }),
    Match.orElse((): Option.Option<CustomerSafeTaxProjection> =>
      Option.some({ _tag: 'TAX_NOT_DETERMINED', contractVersion: CUSTOMER_SAFE_TAX_PROJECTION_VERSION }),
    ),
  );
