import { DateTime, Option, Schema } from 'effect';

import { BoundedIdentifierSchema } from './tax-domain-primitives.ts';
import {
  NonNegativeTaxExactRationalSchema,
  ZERO_TAX_EXACT_RATIONAL,
  taxExactFractionOfPercent,
  taxExactRationalFromDecimal,
} from './tax-exact-rational.ts';
import type { NonNegativeTaxExactRational, TaxExactRational } from './tax-exact-rational.ts';
import type { TaxMonetaryAmount } from './tax-monetary-amount.ts';
import { TaxOutcomeSuccessSchema } from './tax-outcome.ts';
import type { TaxRoundingPolicy } from './tax-rounding.ts';
import { OrderCommitmentTimeSchema } from './tax-time.ts';
import type { TaxableSupplyUnitId } from './taxable-supply-unit.ts';
import { ShippingAllocationBasisSchema } from './shipping-allocation.ts';
import { LineCommercialValueBasisSchema } from './taxable-basis.ts';

const isLineCommercialValue = Schema.is(LineCommercialValueBasisSchema);
const isShippingAllocation = Schema.is(ShippingAllocationBasisSchema);

/**
 * The Authoritative Original Accepted Record whose recorded Tax is the return baseline: the final accepted B2C Order
 * Snapshot, or the accepted Billing Document of the invoiced supply. Order and Billing own and persist their
 * snapshots; TAX keeps no copy (#945 C, #946 F1, F8-F9, #947 F5, F25, PO default D2).
 */
export const AuthoritativeOriginalAcceptedRecordSchema = Schema.Union([
  Schema.TaggedStruct('ORDER_SNAPSHOT', {}),
  Schema.TaggedStruct('BILLING_DOCUMENT', { billingDocumentRef: BoundedIdentifierSchema }),
]);

/** Exact lineage of the accepted Order and the Bundle whose final Tax the record retains (#945 D, #907 F183). */
export const OrderLineageSchema = Schema.Struct({
  bundleRef: BoundedIdentifierSchema,
  orderRef: BoundedIdentifierSchema,
});

/**
 * Accepted Tax Terms: the immutable Tax meaning actually used by one successful Accepted handoff. They are exactly
 * the final Tax Decision/Result of the accepted Bundle for its original Order Commitment Time T, never a second
 * acceptance-time determination, an older preview or a Current lookup. The Decision/Result already retain the exact
 * units, occurrence mapping and quantities, basis allocations, rate, governing Tax Rule revisions, Catalog and place
 * evidence, published amounts with currency and the Tax Rounding policy revision; Tax Evaluation Time stays distinct
 * provenance (#945 D, F1-F9; #946 F2-F7; #907 F169-F178; ADR-0027).
 */
export const AcceptedTaxTermsSchema = Schema.Struct({
  authoritativeRecord: AuthoritativeOriginalAcceptedRecordSchema,
  finalTax: TaxOutcomeSuccessSchema,
  orderCommitmentTime: OrderCommitmentTimeSchema,
  orderLineage: OrderLineageSchema,
}).check(
  Schema.makeFilter(
    ({ finalTax, orderCommitmentTime }) =>
      DateTime.Equivalence(finalTax.decision.taxRelevantTime, orderCommitmentTime) ||
      'Accepted Tax Terms must retain the original Order Commitment Time as their Tax-Relevant Time',
  ),
);
export type AcceptedTaxTerms = typeof AcceptedTaxTermsSchema.Type;

/** Exact original meaning of one Taxable Supply Unit as recorded on the Authoritative Original Accepted Record. */
export interface OriginalUnitBaseline {
  readonly originalLineBasis: NonNegativeTaxExactRational;
  readonly originalPublishedTax: TaxMonetaryAmount;
  readonly originalQuantity: TaxExactRational;
  readonly originalShippingBasis: NonNegativeTaxExactRational;
  readonly rate: TaxExactRational;
  readonly taxRoundingPolicy: TaxRoundingPolicy;
}

/**
 * Baseline of one original unit read only from the accepted record: its exact basis components (Line Commercial
 * Value and any allocated Shipping, zero when none), original rate and published Tax, the accepted quantity of its source occurrence and the used
 * rounding policy. No Catalog, Pricing, Tax Rule or registration source is consulted. A unit outside the record's
 * exact partition has no baseline (#945 F12-F14, #946 F10-F11, #948 F2-F5, F8).
 */
export const originalUnitBaseline = (
  terms: AcceptedTaxTerms,
  taxableSupplyUnitId: TaxableSupplyUnitId,
): Option.Option<OriginalUnitBaseline> => {
  const { decision, result } = terms.finalTax;
  const unit = decision.units.find(({ taxableSupplyUnit }) => taxableSupplyUnit.unitId === taxableSupplyUnitId);
  const published = result.units.find((evidence) => evidence.taxableSupplyUnitId === taxableSupplyUnitId);
  const occurrence = decision.purchaseBinding.purchaseDemandOccurrences.find(
    ({ occurrenceId }) => occurrenceId === unit?.taxableSupplyUnit.mapping.occurrenceId,
  );
  const line = unit?.taxableBasisInterpretation.components.find(isLineCommercialValue);
  const shipping = unit?.taxableBasisInterpretation.components.find(isShippingAllocation);
  if (unit === undefined || published === undefined || occurrence === undefined || line === undefined) {
    return Option.none();
  }
  return Option.map(taxExactRationalFromDecimal(occurrence.quantity.amount), (originalQuantity) => ({
    originalLineBasis: line.amount,
    originalPublishedTax: published.publishedTaxAmount,
    originalQuantity,
    originalShippingBasis: shipping?.amount ?? NonNegativeTaxExactRationalSchema.make(ZERO_TAX_EXACT_RATIONAL),
    rate: taxExactFractionOfPercent(unit.treatment.ratePercent),
    taxRoundingPolicy: result.taxRoundingPolicy,
  }));
};
