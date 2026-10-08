import { Match, Schema } from 'effect';

import { AcceptedTaxTermsSchema } from './accepted-tax-terms.ts';
import type { AcceptedTaxTerms } from './accepted-tax-terms.ts';
import {
  TaxCorrectionDeltaSchema,
  TaxCorrectionHistoricalInputUnresolvedSchema,
  TaxCorrectionOutOfBoundsSchema,
  TaxCorrectionFactsSchema,
  calculateTaxCorrectionDelta,
} from './tax-correction-delta.ts';
import { TaxDecisionIdSchema } from './tax-decision.ts';
import { BoundedIdentifierSchema } from './tax-domain-primitives.ts';
import { TAX_HISTORICAL_INPUT_UNRESOLVED } from './tax-historical-input-outcome.ts';

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

/**
 * One declared use of the Accepted Tax Terms handed over by their owner (Order or Billing). The terms are carried as
 * handed over and established by `acceptedTaxTermsFromHandover`, so a missing or ambiguous original record is the
 * explicit unresolved historical-input outcome rather than a rejected request (#947 F13, #948 F7, #946 F12). Owners
 * encode them with `AcceptedTaxTermsSchema`.
 */
export const DeclaredTaxPurposeRequestSchema = Schema.Struct({
  acceptedTaxTerms: Schema.Unknown,
  declaredPurpose: DeclaredTaxPurposeSchema,
});
export type DeclaredTaxPurposeRequest = typeof DeclaredTaxPurposeRequestSchema.Type;

/** Accepted Tax Terms as handed over, or none when the original record is incomplete or ambiguous. */
export const acceptedTaxTermsFromHandover = Schema.decodeUnknownOption(AcceptedTaxTermsSchema);

/** The original record cannot be established from what its owner handed over (#947 F13, #948 F7). */
export const ORIGINAL_RECORD_INCOMPLETE: DeclaredTaxPurposeOutcome = {
  _tag: TAX_HISTORICAL_INPUT_UNRESOLVED,
  unresolved: { _tag: 'ORIGINAL_RECORD_INCOMPLETE' },
};

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

/** Interprets one declared use; only a supported correction calculates, and only its delta (#947 F10, #948 F13). */
export const interpretDeclaredTaxPurpose = (
  acceptedTaxTerms: AcceptedTaxTerms,
  declaredPurpose: DeclaredTaxPurpose,
): DeclaredTaxPurposeOutcome =>
  Match.value(declaredPurpose).pipe(
    Match.tagsExhaustive({
      CORRECTION: ({ correctionEventRef, correctionReason, units }): DeclaredTaxPurposeOutcome =>
        calculateTaxCorrectionDelta({ acceptedTaxTerms, correctionEventRef, correctionReason, units }),
      HISTORICAL_READ: (): DeclaredTaxPurposeOutcome => ({
        _tag: 'HISTORICAL_READ_USES_ACCEPTED_TAX_TERMS',
        originalTaxDecisionId: acceptedTaxTerms.finalTax.decision.decisionId,
      }),
      NEW_EVENT: ({ eventKind, eventRef }): DeclaredTaxPurposeOutcome =>
        eventKind === 'PARTIAL_FULFILLMENT'
          ? { _tag: 'NO_NEW_TAX_EVENT', eventRef }
          : { _tag: 'NEW_EVENT_DETERMINATION_UNSUPPORTED', eventRef },
    }),
  );
