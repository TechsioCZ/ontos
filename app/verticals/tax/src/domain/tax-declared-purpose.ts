import { Match } from 'effect';

import type { AcceptedTaxTerms } from './accepted-tax-terms.ts';
import { calculateTaxCorrectionDelta } from './tax-correction-delta.ts';
import type {
  DeclaredTaxPurpose,
  DeclaredTaxPurposeOutcome,
} from '../../shared/domain/tax-kernel/tax-declared-purpose.ts';

export {
  HistoricalReadUsesAcceptedTaxTermsSchema,
  NewEventDeterminationUnsupportedSchema,
  NoNewTaxEventSchema,
} from '../../shared/domain/tax-kernel/tax-declared-purpose.ts';
export type {
  DeclaredTaxPurpose,
  DeclaredTaxPurposeOutcome,
} from '../../shared/domain/tax-kernel/tax-declared-purpose.ts';

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
