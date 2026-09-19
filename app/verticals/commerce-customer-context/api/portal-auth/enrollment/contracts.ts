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
export const CommercePortalAuthEnrollmentStartInputSchema = Schema.Struct({
  displayName: EnrollmentDisplayNameSchema,
  email: EnrollmentEmailSchema,
  invitationId: Schema.optionalKey(EnrollmentInvitationIdSchema),
  journey: EnrollmentJourneySchema,
  partyRef: Schema.optionalKey(EnrollmentResourceIdSchema),
  password: EnrollmentPasswordSchema,
  sellingLegalEntityId: EnrollmentLegalEntityIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type CommercePortalAuthEnrollmentStartInput = typeof CommercePortalAuthEnrollmentStartInputSchema.Type;

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
