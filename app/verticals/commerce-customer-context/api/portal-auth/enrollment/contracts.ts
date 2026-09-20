import { Schema } from 'effect';

import {
  EnrollmentAttemptIdSchema,
  EnrollmentAttemptStateSchema,
  EnrollmentInvitationIdSchema,
  EnrollmentJourneySchema,
  EnrollmentLegalEntityIdSchema,
  EnrollmentResourceIdSchema,
} from '../../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptSnapshot } from '../../../shared/enrollment-contracts.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../provider/config.ts';

/**
 * The enrollment transport boundary.
 *
 * This is the credential carrier: it is the only Commerce route that accepts an enrollment
 * password, and the password is a `Redacted` string from the moment it is decoded. It never enters
 * the durable Enrollment Attempt, never reaches a digest, and never leaves this vertical except as
 * the provider account-creation transition's own private payload — the Attempt journal records
 * only the resulting account subject.
 */

const EnrollmentEmailSchema = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(3), Schema.isMaxLength(320));

/**
 * The same password bounds the sign-in route enforces. Reusing the policy rather than a literal is
 * deliberate: a deployment that tightens its password policy tightens enrollment with it, so an
 * account can never be created with a credential its own sign-in route would refuse.
 */
const EnrollmentPasswordSchema = Schema.Redacted(
  Schema.String.check(
    Schema.isMinLength(COMMERCE_PORTAL_AUTH_POLICY.password.minLength),
    Schema.isMaxLength(COMMERCE_PORTAL_AUTH_POLICY.password.maxLength),
  ),
);

const EnrollmentDisplayNameSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
);

/**
 * What a caller may name when starting an enrollment. Everything else — Tenant, Actor, the Attempt
 * identity, the intent digest and every owner transition key — is derived from the governed
 * context and the journey's own declaration, so a caller cannot choose which owner transitions its
 * Attempt will be gated on.
 */
const enrollmentStartFields = {
  displayName: EnrollmentDisplayNameSchema,
  email: EnrollmentEmailSchema,
  partyRef: Schema.optionalKey(EnrollmentResourceIdSchema),
  password: EnrollmentPasswordSchema,
  sellingLegalEntityId: EnrollmentLegalEntityIdSchema,
} as const;

const rejectExcessProperties = { parseOptions: { onExcessProperty: 'error' } } as const;

/**
 * The start payload is a discriminated union rather than one struct with an optional invitation,
 * because the two are not independent: a Counterparty invitation enrollment is meaningless without
 * the invitation it claims, and any other journey that names one is asking for a journey it did not
 * select. Stating the dependency in the schema rejects every such combination at decode — before a
 * governed Action runs, before an Attempt is persisted and before any provider mutation.
 */
export const CommercePortalAuthEnrollmentStartInputSchema = Schema.Union([
  Schema.Struct({ ...enrollmentStartFields, journey: Schema.Literal('RETAIL_SELF_ENROLLMENT') }).annotate(
    rejectExcessProperties,
  ),
  Schema.Struct({
    ...enrollmentStartFields,
    invitationId: EnrollmentInvitationIdSchema,
    journey: Schema.Literal('COUNTERPARTY_INVITATION'),
  }).annotate(rejectExcessProperties),
  // Existing-account enrollment continues an already-authenticated subject into a second Tenant,
  // and it enters that Tenant as the journey its own definition composes. Naming an invitation here
  // would ask for a Counterparty claim no owner effect can perform, so the Attempt would journal an
  // ownership proof and then halt forever: the combination is refused at decode, as Retail's is.
  Schema.Struct({ ...enrollmentStartFields, journey: Schema.Literal('EXISTING_ACCOUNT') }).annotate(
    rejectExcessProperties,
  ),
]);
export type CommercePortalAuthEnrollmentStartInput = typeof CommercePortalAuthEnrollmentStartInputSchema.Type;

/** The invitation this start request names, or `undefined` for a journey that carries none. */
export const commercePortalAuthEnrollmentInvitationId = (
  input: CommercePortalAuthEnrollmentStartInput,
): typeof EnrollmentInvitationIdSchema.Type | undefined =>
  input.journey === 'COUNTERPARTY_INVITATION' ? input.invitationId : undefined;

/**
 * The projection a caller may observe. It is deliberately narrower than the durable Attempt
 * snapshot: the lease, the owner invocation identity, the intent digest and the failure reason are
 * owner-internal and never reach a customer. `state` is derived from durable owner outcomes, so a
 * caller reads completion rather than asserting it.
 */
export const CommercePortalAuthEnrollmentAttemptProjectionSchema = Schema.Struct({
  invitationId: Schema.optionalKey(EnrollmentInvitationIdSchema),
  journey: EnrollmentJourneySchema,
  portalEnrollmentAttemptId: EnrollmentAttemptIdSchema,
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  state: EnrollmentAttemptStateSchema,
  targetLegalEntityId: Schema.optionalKey(EnrollmentLegalEntityIdSchema),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type CommercePortalAuthEnrollmentAttemptProjection =
  typeof CommercePortalAuthEnrollmentAttemptProjectionSchema.Type;

/**
 * Narrow one durable Attempt to its published projection. Written as an explicit field list rather
 * than a spread so that a field added to the durable snapshot is never published by accident.
 */
export const commercePortalAuthEnrollmentAttemptProjection = (
  attempt: EnrollmentAttemptSnapshot,
): CommercePortalAuthEnrollmentAttemptProjection => {
  const base = {
    journey: attempt.journey,
    portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
    revision: attempt.revision,
    state: attempt.state,
  };
  const withInvitation = attempt.invitationId === undefined ? base : { ...base, invitationId: attempt.invitationId };
  return attempt.targetLegalEntityId === undefined
    ? withInvitation
    : { ...withInvitation, targetLegalEntityId: attempt.targetLegalEntityId };
};
