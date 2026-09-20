import { randomUUID } from 'node:crypto';
import { Effect, Schema } from 'effect';

import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentDigestSchema,
  EnrollmentKeySchema,
  EnrollmentModuleKeySchema,
  EnrollmentTransitionKeySchema,
  enrollmentDigest,
} from '../../../shared/enrollment-contracts.ts';
import type { StartPortalEnrollmentPayload } from '../../../shared/actions/start-portal-enrollment.ts';
import {
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  PORTAL_AUTH_OWNER_MODULE_KEY,
} from '../../../src/enrollment/orchestration/prepared-owner-authority.ts';
import { commercePortalAuthEnrollmentInvitationId } from './contracts.ts';
import type { CommercePortalAuthEnrollmentStartInput } from './contracts.ts';

/**
 * The credential-free half of a start request.
 *
 * Everything below is derived from the business intent alone: the journey, the target selling
 * Legal Entity, the invitation and the Party the caller named. The password and the display name
 * are deliberately absent from every digest — an equivalent retry must converge on the exact same
 * Attempt and the exact same owner operation, and a digest that moved with the credential would
 * turn a password correction into a second account.
 */

const ENROLLMENT_INTENT_KEY_PREFIX = 'commerce.customer-context.portal-enrollment';

const digestOf = (parts: readonly string[]): string => enrollmentDigest(parts.join('\u0000'));

const normalizedEmail = (input: CommercePortalAuthEnrollmentStartInput): string => input.email.trim().toLowerCase();

/**
 * The enrolling identity, as a digest.
 *
 * `portal_enrollment_attempts` is unique on `(tenant_id, intent_key)`, so the key must name *who*
 * is enrolling and not only *how*: a key carrying the journey alone makes every enrolling person in
 * one Tenant collide on a single Attempt row. An invitation enrollment is identified by the
 * invitation it claims — two people may not claim the same one — and every other journey by the
 * normalized address, which is exactly the value a retry re-presents.
 */
const enrollmentIdentityDigest = (input: CommercePortalAuthEnrollmentStartInput): string => {
  const invitationId = commercePortalAuthEnrollmentInvitationId(input);
  return input.journey === 'COUNTERPARTY_INVITATION' && invitationId !== undefined
    ? digestOf(['invitation', invitationId])
    : digestOf(['email', normalizedEmail(input)]);
};

/**
 * The durable intent the `start-portal-enrollment` Action records. `intentKey` names the journey
 * and the enrolling identity, so two journeys never share an Attempt and two people never do
 * either; `intentDigest` is what makes an equivalent retry by that same identity idempotent.
 */
export const commercePortalAuthEnrollmentIntent = (
  input: CommercePortalAuthEnrollmentStartInput,
): Effect.Effect<StartPortalEnrollmentPayload, Schema.SchemaError> => {
  const invitationId = commercePortalAuthEnrollmentInvitationId(input);
  return Effect.all(
    {
      intentDigest: Schema.decodeEffect(EnrollmentDigestSchema)(
        digestOf([
          input.journey,
          normalizedEmail(input),
          input.sellingLegalEntityId,
          invitationId ?? '',
          input.partyRef ?? '',
        ]),
      ),
      intentKey: Schema.decodeEffect(EnrollmentKeySchema)(
        `${ENROLLMENT_INTENT_KEY_PREFIX}.${input.journey.toLowerCase()}.${enrollmentIdentityDigest(input)}`,
      ),
      // Two independent in-memory decodes of values this module derived itself.
    },
    { concurrency: 2 },
  ).pipe(
    Effect.map(({ intentDigest, intentKey }) => {
      const base = {
        intentDigest,
        intentKey,
        journey: input.journey,
        targetLegalEntityId: input.sellingLegalEntityId,
      };
      const withInvitation = invitationId === undefined ? base : { ...base, invitationId };
      return input.partyRef === undefined ? withInvitation : { ...withInvitation, targetResourceId: input.partyRef };
    }),
  );
};

/** The immutable identity of the provider account-creation transition this vertical owns. */
export interface CommercePortalAuthEnrollmentAccountCreationClaim {
  readonly ownerInvocationId: typeof EnrollmentActionInvocationIdSchema.Type;
  readonly ownerModuleKey: typeof EnrollmentModuleKeySchema.Type;
  readonly requestDigest: typeof EnrollmentDigestSchema.Type;
  readonly transitionKey: typeof EnrollmentTransitionKeySchema.Type;
}

/**
 * Mint the claim for the first owner transition of a start request. The owner invocation identity
 * is fresh per request on purpose: the durable claim, not this value, is what deduplicates — a
 * replayed claim against an already-claimed transition is reported as such by the Attempt journal
 * rather than silently creating a second provider account.
 *
 * The request digest is derived from the same credential-free business intent as the Attempt's own
 * digest, so the installed owner preparation port can re-derive and compare it without ever seeing
 * the credential.
 */
export const commercePortalAuthEnrollmentAccountCreationClaim = (
  input: CommercePortalAuthEnrollmentStartInput,
  portalEnrollmentAttemptId: string,
): Effect.Effect<CommercePortalAuthEnrollmentAccountCreationClaim, Schema.SchemaError> =>
  Effect.all(
    {
      ownerInvocationId: Schema.decodeEffect(EnrollmentActionInvocationIdSchema)(randomUUID()),
      ownerModuleKey: Schema.decodeEffect(EnrollmentModuleKeySchema)(PORTAL_AUTH_OWNER_MODULE_KEY),
      requestDigest: Schema.decodeEffect(EnrollmentDigestSchema)(
        digestOf([
          PORTAL_AUTH_OWNER_MODULE_KEY,
          PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
          portalEnrollmentAttemptId,
          input.journey,
          normalizedEmail(input),
          input.sellingLegalEntityId,
        ]),
      ),
      transitionKey: Schema.decodeEffect(EnrollmentTransitionKeySchema)(PORTAL_ACCOUNT_CREATION_TRANSITION_KEY),
      // Four independent in-memory decodes; none reaches a shared downstream resource.
    },
    { concurrency: 4 },
  );
