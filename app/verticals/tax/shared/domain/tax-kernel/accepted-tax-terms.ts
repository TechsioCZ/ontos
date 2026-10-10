import { DateTime, Schema } from 'effect';

import { BoundedIdentifierSchema } from './tax-domain-primitives.ts';
import { TaxOutcomeSuccessSchema } from './tax-outcome.ts';
import { OrderCommitmentTimeSchema } from './tax-time.ts';

/**
 * The Authoritative Original Accepted Record whose recorded Tax is the return baseline. For an invoiced sale, the
 * record is the accepted Billing Document **only** — every completed sale is invoiced (H10, a product rule). The
 * Order Snapshot member is limited to the confirmed pre-document boundary: historical reads of the Order's own Tax
 * and declared events before any Billing Document exists. It is never a correction baseline. Order and Billing own
 * and persist their snapshots; TAX keeps no copy (#945 C, #946 F1, F8-F9, #947 F5, F25, PO default D2;
 * #945-#948 H10).
 */
export const AuthoritativeOriginalAcceptedRecordSchema = Schema.Union([
  Schema.TaggedStruct('ORDER_SNAPSHOT', {}),
  Schema.TaggedStruct('BILLING_DOCUMENT', { billingDocumentRef: BoundedIdentifierSchema }),
]);

/** Whether the record is the accepted Billing Document, the only record a correction may use (H10). */
export const isBillingDocumentRecord = Schema.is(AuthoritativeOriginalAcceptedRecordSchema.members[1]);

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
 * provenance. Terms inherit the Seller VAT Regime and its declaration revision through `finalTax.decision`; no new
 * field is needed here (#945 D, F1-F9; #946 F2-F7; #907 F169-F178; ADR-0027; Unit 10 A5). A correction's Terms carry
 * the accepted Billing Document as their `authoritativeRecord`; the Order Snapshot member is used only within the
 * confirmed pre-document boundary and is never a correction baseline (H10).
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
