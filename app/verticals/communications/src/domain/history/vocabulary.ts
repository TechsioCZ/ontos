import { Schema } from 'effect';

// The provider-facing vocabulary is the published handoff contract (step 22 meets exactly these literals); it is not restated here.
export {
  FailureClassSchema,
  ObservationEvidenceSchema,
  ObservationKindSchema,
  ProviderKeySchema,
  ProviderObservationKeySchema,
  ProviderRefSchema,
} from '@app/communications-contracts/message-handoff';
export type { FailureClass, ObservationKind } from '@app/communications-contracts/message-handoff';

/**
 * Closed vocabularies of the truthful message history (#1402). Every value that can reach a history row is one of these
 * literals or an opaque identity text restricted to a safe alphabet, so an address, a link, markup or a secret has no way in.
 */

/**
 * The state of one delivery attempt, as the pre-handoff lane stores it. `MESSAGE_INVALID` is stored only when the Messaging Adapter
 * PROVED that our own message was malformed and the provider was never asked (`proof: 'PROVIDER_NOT_ASKED'` in the handoff contract).
 */
export const AttemptStateSchema = Schema.Literals([
  'ACCEPTED',
  'INDETERMINATE',
  'MESSAGE_INVALID',
  'NOT_ATTEMPTED',
  'PREPARED',
  'REJECTED',
  'UNAVAILABLE',
]);
export type AttemptState = typeof AttemptStateSchema.Type;

/**
 * The distinct technical evidence of a submission, kept apart so no one is mistaken for another. Only `PROVIDER_ACCEPTED`
 * says that a provider took the submission; `ACCEPTANCE_INDETERMINATE` and `PROVIDER_UNAVAILABLE` say the opposite of nothing:
 * the effect is unknown.
 */
export const TechnicalEvidenceSchema = Schema.Literals([
  'ACCEPTANCE_INDETERMINATE',
  'MESSAGE_INVALID',
  'NOT_ATTEMPTED',
  'PROVIDER_ACCEPTED',
  'PROVIDER_REJECTED',
  'PROVIDER_UNAVAILABLE',
  'SUBMISSION_STARTED',
]);
export type TechnicalEvidence = typeof TechnicalEvidenceSchema.Type;

/**
 * What a fact proves about the EXTERNAL effect of one attempt: it left, it provably did not, nobody knows, or the evidence
 * contradicts itself and no side is preferred.
 */
export const AttemptEffectSchema = Schema.Literals(['ABSENT', 'CONTRADICTORY', 'PRESENT', 'UNKNOWN']);
export type AttemptEffect = typeof AttemptEffectSchema.Type;

/** A closed upper-case reason code of a link; the lane that writes it owns the vocabulary, never free text. */
export const LinkReasonCodeSchema = Schema.String.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u),
).pipe(Schema.brand('LinkReasonCode'));
