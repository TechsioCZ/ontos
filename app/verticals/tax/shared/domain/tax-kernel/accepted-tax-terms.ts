import { DateTime, Schema } from 'effect';

import { BoundedIdentifierSchema } from './tax-domain-primitives.ts';
import { TaxOutcomeSuccessSchema } from './tax-outcome.ts';
import { OrderCommitmentTimeSchema } from './tax-time.ts';
import { ShippingAllocationBasisSchema } from './shipping-allocation.ts';
import { LineCommercialValueBasisSchema } from './taxable-basis.ts';

export const isLineCommercialValue = Schema.is(LineCommercialValueBasisSchema);

export const isShippingAllocation = Schema.is(ShippingAllocationBasisSchema);

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
