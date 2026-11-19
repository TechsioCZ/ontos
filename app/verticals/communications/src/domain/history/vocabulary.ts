import { Schema } from 'effect';

/**
 * Closed vocabularies of the truthful message history (#1402). Every value that can reach a history row is one of these
 * literals or an opaque identity text restricted to a safe alphabet, so an address, a link, markup or a secret has no way in.
 */

/** The state of one delivery attempt, as the pre-handoff lane stores it. */
export const AttemptStateSchema = Schema.Literals([
  'ACCEPTED',
  'INDETERMINATE',
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

/** An opaque, safe identity text: the provider's own event or message identity, never an address, URL or token. */
export const SafeIdentitySchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
);
export const ProviderKeySchema = SafeIdentitySchema.pipe(Schema.brand('ProviderKey'));
export const ProviderObservationKeySchema = SafeIdentitySchema.pipe(Schema.brand('ProviderObservationKey'));
export const ProviderRefSchema = SafeIdentitySchema.pipe(Schema.brand('ProviderRef'));

/** A closed upper-case reason code of a link; the lane that writes it owns the vocabulary, never free text. */
export const LinkReasonCodeSchema = Schema.String.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u),
).pipe(Schema.brand('LinkReasonCode'));

/**
 * What a provider observation can PROVE about one attempt. Delivery exists only here, and only with a provider event:
 * - ACCEPTANCE_PROVEN: the provider accepted the submission (a provider event, or a reconciliation after an unknown answer);
 * - NON_ACCEPTANCE_PROVEN: a reconciliation proved the provider did NOT accept it, so the effect is provably absent;
 * - DELIVERY_PROVEN: the provider evidenced delivery of THIS message (needs real step 22 proof capability);
 * - DELIVERY_FAILED: a provider event proved a failure after acceptance (bounce, drop); the acceptance stays.
 */
export const ObservationKindSchema = Schema.Literals([
  'ACCEPTANCE_PROVEN',
  'DELIVERY_FAILED',
  'DELIVERY_PROVEN',
  'NON_ACCEPTANCE_PROVEN',
]);
export type ObservationKind = typeof ObservationKindSchema.Type;

export const FailureClassSchema = Schema.Literals(['BOUNCED_PERMANENT', 'BOUNCED_TRANSIENT', 'DROPPED_BY_PROVIDER']);
export type FailureClass = typeof FailureClassSchema.Type;

/**
 * The minimal evidence of an observation: what it proves and how it is known (a provider event or a reconciliation),
 * never the provider payload. The basis is part of the type: a delivery claim or a failure after acceptance can only rest on
 * a provider event, and a proven non-acceptance only on a reconciliation.
 */
export const ObservationEvidenceSchema = Schema.Union([
  Schema.Struct({
    basis: Schema.Literals(['PROVIDER_EVENT', 'RECONCILIATION']),
    kind: Schema.Literal('ACCEPTANCE_PROVEN'),
  }),
  Schema.Struct({ basis: Schema.Literal('RECONCILIATION'), kind: Schema.Literal('NON_ACCEPTANCE_PROVEN') }),
  Schema.Struct({ basis: Schema.Literal('PROVIDER_EVENT'), kind: Schema.Literal('DELIVERY_PROVEN') }),
  Schema.Struct({
    basis: Schema.Literal('PROVIDER_EVENT'),
    failureClass: FailureClassSchema,
    kind: Schema.Literal('DELIVERY_FAILED'),
  }),
]);
