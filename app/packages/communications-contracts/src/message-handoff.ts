import { Schema } from 'effect';

import { DeliveryAttemptIdSchema, MessageIntentIdSchema } from './communication-intake.ts';

/**
 * Published, schema-only handoff contract between Communications and the Messaging Adapter (step 22): what the adapter answers
 * for ONE handoff attempt, and the one input through which it later gives Communications evidence about that attempt (#1402,
 * #1403, #1411). Step 21 owns the shape and the meaning below; step 22 owns the provider, its transport, its callbacks and its
 * reconciliation. Nothing here has a field for a provider payload, an address, a link, markup or a secret.
 *
 * What an answer MEANS about the external effect (Communications is the only interpreter into the business vocabulary):
 * - ACCEPTED: the provider took the API submission. It is NEVER delivery: the history says PROVIDER_ACCEPTED and nothing more;
 * - REJECTED: the provider explicitly refused it, so nothing was accepted (a proven non-acceptance);
 * - UNAVAILABLE: with `configuration` no request was made at all (nothing was submitted); with `provider_unavailable` the
 *   provider could not be used, which does NOT prove it did not accept the message (the effect is unknown);
 * - INDETERMINATE: a timeout, a transport failure or an unreadable answer; the message may have been accepted, so the effect
 *   is unknown, nothing is ever resent blindly and only a reconciliation (a `ProviderObservationInput` proving acceptance or
 *   non-acceptance) ends the doubt;
 * - NOT_ATTEMPTED: no adapter exists in the deployment; nothing was submitted;
 * - MESSAGE_INVALID: our own message was malformed and the provider was NEVER asked. The adapter must state that proof
 *   (`proof: 'PROVIDER_NOT_ASKED'`); Communications never infers it from a provider answer or a worker guess, so a failure
 *   that was not proven this way stays INDETERMINATE.
 */

/** The Tenant an observation CLAIMS to belong to: a claim to be checked against the verified scope, never a scope. */
export const ObservationTenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('ProviderObservationTenantId'),
);

/** An opaque, safe identity text: the provider's own event or message identity, never an address, URL or token. */
export const SafeIdentitySchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
);
export const ProviderKeySchema = SafeIdentitySchema.pipe(Schema.brand('ProviderKey'));
export const ProviderObservationKeySchema = SafeIdentitySchema.pipe(Schema.brand('ProviderObservationKey'));
export const ProviderRefSchema = SafeIdentitySchema.pipe(Schema.brand('ProviderRef'));

/**
 * The answer of one handoff. The reasons are the closed literals of the provider seam (`@app/email-delivery`), restated here
 * because this package is schema-only and independent of it; the deployment checks that the two cannot drift.
 */
export const HandoffAcceptedSchema = Schema.Struct({
  kind: Schema.Literal('ACCEPTED'),
  providerKey: ProviderKeySchema,
  providerRef: ProviderRefSchema,
});
export const HandoffIndeterminateSchema = Schema.Struct({
  kind: Schema.Literal('INDETERMINATE'),
  reason: Schema.Literals(['response_invalid', 'timeout', 'transport']),
});
export const HandoffNotAttemptedSchema = Schema.Struct({
  kind: Schema.Literal('NOT_ATTEMPTED'),
  reason: Schema.Literal('NO_ADAPTER_CONFIGURED'),
});
export const HandoffRejectedSchema = Schema.Struct({
  kind: Schema.Literal('REJECTED'),
  reason: Schema.Literals(['provider_rejected', 'rate_limited']),
});
export const HandoffUnavailableSchema = Schema.Struct({
  kind: Schema.Literal('UNAVAILABLE'),
  reason: Schema.Literals(['configuration', 'provider_unavailable']),
});
/** The only way a malformed message becomes a certain failure: the adapter proves it never asked the provider. */
export const HandoffMessageInvalidSchema = Schema.Struct({
  field: Schema.Literals(['from', 'html', 'idempotencyKey', 'subject', 'text', 'to']),
  kind: Schema.Literal('MESSAGE_INVALID'),
  proof: Schema.Literal('PROVIDER_NOT_ASKED'),
  reason: Schema.Literals(['control_character', 'empty', 'invalid_format', 'too_long']),
});

export const MessageHandoffOutcomeSchema = Schema.Union([
  HandoffAcceptedSchema,
  HandoffIndeterminateSchema,
  HandoffNotAttemptedSchema,
  HandoffRejectedSchema,
  HandoffUnavailableSchema,
  HandoffMessageInvalidSchema,
]);
export type MessageHandoffOutcome = typeof MessageHandoffOutcomeSchema.Type;

/** The answer of one attempt, bound to the identities it was asked for so a mixed-up answer is recognized. */
export const MessageHandoffResultSchema = Schema.Struct({
  attemptId: DeliveryAttemptIdSchema,
  intentId: MessageIntentIdSchema,
  outcome: MessageHandoffOutcomeSchema,
  tenantId: ObservationTenantIdSchema,
});
export type MessageHandoffResult = typeof MessageHandoffResultSchema.Type;

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

/**
 * A provider observation as step 22 hands it to Communications (#1402): keyed to exactly one (Tenant, intent, attempt) and to
 * the provider's own identity of the event, carrying the minimal evidence only. Step 22 owns how it obtains the evidence
 * (callbacks, signatures, reconciliation transport); nothing here requires open or read tracking, and without a real proof
 * capability the correct history simply has no delivery claim. An attempt that provably submitted nothing has nothing to
 * observe, and an observation never begins, finishes or schedules an attempt: it can never cause a second send.
 */
export const ProviderObservationInputSchema = Schema.Struct({
  attemptId: DeliveryAttemptIdSchema,
  evidence: ObservationEvidenceSchema,
  intentId: MessageIntentIdSchema,
  /**
   * The provider's own identity of THIS event: the same event delivered again carries the same key. Together with the evidence
   * kind it is the identity of the observation: the same key and kind with another content is a CONFLICT, the same key with
   * another kind is a NEW observation.
   */
  observationKey: ProviderObservationKeySchema,
  /** When the provider says it happened. Informational only: it is part of the content, never the order of the timeline. */
  observedAt: Schema.DateTimeUtcFromString,
  providerKey: ProviderKeySchema,
  /** The provider's opaque reference of the submission, when the event names it. */
  providerRef: Schema.optionalKey(ProviderRefSchema),
  /** The Tenant the observation CLAIMS; it is checked against the verified scope and never used to choose where it is stored. */
  tenantId: ObservationTenantIdSchema,
});
export type ProviderObservationInput = typeof ProviderObservationInputSchema.Type;
