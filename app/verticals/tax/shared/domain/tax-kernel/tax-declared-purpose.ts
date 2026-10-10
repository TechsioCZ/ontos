import { Match, Schema } from 'effect';

import { AcceptedTaxTermsSchema, isBillingDocumentRecord } from './accepted-tax-terms.ts';
import {
  TaxCorrectionDeltaSchema,
  TaxCorrectionHistoricalInputUnresolvedSchema,
  TaxCorrectionOutOfBoundsSchema,
  TaxCorrectionFactsSchema,
  OriginalRecordUnavailableSchema,
} from './tax-correction-delta.ts';
import { TaxDecisionIdSchema } from './tax-decision.ts';
import { BoundedIdentifierSchema } from './tax-domain-primitives.ts';

/**
 * Explicit declared use of Accepted Tax Terms after acceptance: a historical read, a supported return/correction, or
 * a later event. TAX, not a document type or equal totals, interprets the use (#947 A, F1-F3, F5-F12, F16-F23;
 * #946 F21-F25; #907 F179-F182).
 */
export const DeclaredTaxPurposeSchema = Schema.Union([
  Schema.TaggedStruct('HISTORICAL_READ', {}),
  Schema.TaggedStruct('CORRECTION', TaxCorrectionFactsSchema.fields),
  Schema.TaggedStruct('NEW_EVENT', {
    eventKind: Schema.Literals(['PARTIAL_FULFILLMENT', 'INDEPENDENT_SUPPLY']),
    eventRef: BoundedIdentifierSchema,
  }),
]);

export type DeclaredTaxPurpose = typeof DeclaredTaxPurposeSchema.Type;

const isAcceptedTaxTerms = Schema.is(AcceptedTaxTermsSchema);

/**
 * One declared use of the Accepted Tax Terms handed over by their owner (Order or Billing), or the owner's explicit
 * statement that it cannot establish the original record, which TAX answers with the unresolved historical-input
 * outcome instead of a calculation (#947 F13, #948 F7, #946 F12). A `CORRECTION` declared over established Terms
 * uses the accepted Billing Document as its original record; `HISTORICAL_READ` and `NEW_EVENT` still accept the
 * Order Snapshot, the confirmed pre-document boundary (H10).
 */
export const DeclaredTaxPurposeRequestSchema = Schema.Struct({
  acceptedTaxTerms: Schema.Union([AcceptedTaxTermsSchema, OriginalRecordUnavailableSchema]),
  declaredPurpose: DeclaredTaxPurposeSchema,
}).check(
  Schema.makeFilter(({ acceptedTaxTerms, declaredPurpose }) =>
    Match.value(declaredPurpose).pipe(
      Match.tag(
        'CORRECTION',
        () =>
          !isAcceptedTaxTerms(acceptedTaxTerms) ||
          isBillingDocumentRecord(acceptedTaxTerms.authoritativeRecord) ||
          'A correction of an invoiced sale uses the accepted Billing Document as its original record',
      ),
      Match.orElse(() => true),
    ),
  ),
);

/**
 * A historical read is answered by the retained Accepted Tax Terms themselves; TAX makes no fresh Current Decision
 * and does not relabel the old result as Current (#947 F1-F4, #946 F21, #907 F181).
 */
export const HistoricalReadUsesAcceptedTaxTermsSchema = Schema.TaggedStruct('HISTORICAL_READ_USES_ACCEPTED_TAX_TERMS', {
  originalTaxDecisionId: TaxDecisionIdSchema,
});

/**
 * A Fulfillment split or partial delivery is a logistics meaning; no activated Launch contract makes it a new
 * Tax-relevant supply, so no Tax Decision is fabricated (#948 F32-F37, #946 F24, #907 F196-F199).
 */
export const NoNewTaxEventSchema = Schema.TaggedStruct('NO_NEW_TAX_EVENT', { eventRef: BoundedIdentifierSchema });

/**
 * A genuinely independent later supply needs its own declared-purpose determination, which Launch does not activate.
 * It fails explicitly instead of falling back to a live calculation or to reuse of historical Tax (#947 F16-F22).
 */
export const NewEventDeterminationUnsupportedSchema = Schema.TaggedStruct('NEW_EVENT_DETERMINATION_UNSUPPORTED', {
  eventRef: BoundedIdentifierSchema,
});

export const DeclaredTaxPurposeOutcomeSchema = Schema.Union([
  TaxCorrectionDeltaSchema,
  TaxCorrectionHistoricalInputUnresolvedSchema,
  TaxCorrectionOutOfBoundsSchema,
  HistoricalReadUsesAcceptedTaxTermsSchema,
  NoNewTaxEventSchema,
  NewEventDeterminationUnsupportedSchema,
]);

export type DeclaredTaxPurposeOutcome = typeof DeclaredTaxPurposeOutcomeSchema.Type;
