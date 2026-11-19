import { Option, Schema } from 'effect';
import type { LanguageMode } from '../../../shared/language-policy.ts';
import { usablePin } from './selection.ts';
import type { LanguagePolicySnapshot, RevisionAvailability, SelectedLanguageDecision } from './vocabulary.ts';

/** Why the last stoppable handoff of a pinned message does not go ahead. */
export const LanguageHandoffStopReasonSchema = Schema.Literals([
  'czech_revision_required_by_mode_b',
  'language_policy_unreadable',
  'template_revision_ambiguous',
]);
export type LanguageHandoffStopReason = typeof LanguageHandoffStopReasonSchema.Type;

export type LanguageHandoffCheck =
  | { readonly decision: SelectedLanguageDecision; readonly outcome: 'proceed' }
  | { readonly currentMode?: LanguageMode; readonly outcome: 'stop'; readonly reason: LanguageHandoffStopReason };

export interface LanguageHandoffInput {
  /** The Current availability of the Czech revision of the pinned type and scope, resolved now. */
  readonly currentCzech: RevisionAvailability;
  /** The decision stored with the Message Intent. It is the only record of language and revision this gate reads. */
  readonly decision: SelectedLanguageDecision;
  readonly policy: LanguagePolicySnapshot;
}

/**
 * The Current gate before the last handoff that can still be stopped (L-13), retry included. It reads the stored
 * decision and the Current mode, nothing else: no recipient language, source locale or newer revision can reach it, so a
 * retry cannot select again. It returns the very same decision or stops; it never rewrites the language or the revision.
 * - An unreadable Tenant mode blocks the handoff.
 * - A pinned English message needs the Current mode's condition: tightening A to B without a usable Czech revision of the
 *   exact type and scope stops it, loosening B to A never resends a message that was already not sent.
 */
export const checkLanguageHandoff = (input: LanguageHandoffInput): LanguageHandoffCheck => {
  if (input.policy.kind === 'unreadable') {
    return { outcome: 'stop', reason: 'language_policy_unreadable' };
  }
  const currentMode = input.policy.mode;
  if (
    input.decision.language === 'en' &&
    currentMode === 'B' &&
    Option.isNone(usablePin(input.currentCzech, input.decision.pin, 'cs'))
  ) {
    return {
      currentMode,
      outcome: 'stop',
      reason:
        input.currentCzech.kind === 'ambiguous' ? 'template_revision_ambiguous' : 'czech_revision_required_by_mode_b',
    };
  }
  return { decision: input.decision, outcome: 'proceed' };
};
