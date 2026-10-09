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
import { PORTAL_ACCOUNT_VERIFICATION_TRANSITION_KEY } from '../../../src/enrollment/journeys/existing-account.ts';
import { retailSelfEnrollmentEvidenceReference } from '../../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
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

/**
 * What the start route's owner invocation identities are derived from. It names this exact purpose
 * so a start's identity can never collide with the continuation's own derivation for the same
 * Attempt and the same transition.
 */
const ENROLLMENT_START_INVOCATION_PURPOSE = 'commerce.portal-enrollment.start.owner-invocation';

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
  return invitationId === undefined
    ? digestOf(['email', normalizedEmail(input)])
    : digestOf(['invitation', invitationId]);
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

/** The immutable identity of one owner transition an enrollment start claims for itself. */
export interface CommercePortalAuthEnrollmentTransitionClaim {
  readonly ownerInvocationId: typeof EnrollmentActionInvocationIdSchema.Type;
  readonly ownerModuleKey: typeof EnrollmentModuleKeySchema.Type;
  readonly requestDigest: typeof EnrollmentDigestSchema.Type;
  readonly transitionKey: typeof EnrollmentTransitionKeySchema.Type;
}

/**
 * Mint the claim for the first owner transition of a start request. The owner invocation identity
 * is derived, never minted: an equivalent retry of the same start — the same Idempotency-Key, the
 * same Attempt, the same transition — must present the byte-identical Action payload, or the Action
 * runtime hashes it differently and refuses the retry as a second request instead of replaying it.
 * The continuation derives its own invocation identities the same way, for the same reason.
 *
 * The request digest is derived from the same credential-free business intent as the Attempt's own
 * digest, so the installed owner preparation port can re-derive and compare it without ever seeing
 * the credential. The transition key is part of both derivations, so the two transitions a start
 * may claim never collide on one digest or one invocation identity.
 */
const enrollmentTransitionClaim = (
  transitionKey: string,
  input: CommercePortalAuthEnrollmentStartInput,
  portalEnrollmentAttemptId: string,
): Effect.Effect<CommercePortalAuthEnrollmentTransitionClaim, Schema.SchemaError> =>
  Effect.all(
    {
      ownerInvocationId: Schema.decodeEffect(EnrollmentActionInvocationIdSchema)(
        retailSelfEnrollmentEvidenceReference([
          ENROLLMENT_START_INVOCATION_PURPOSE,
          PORTAL_AUTH_OWNER_MODULE_KEY,
          portalEnrollmentAttemptId,
          transitionKey,
        ]),
      ),
      ownerModuleKey: Schema.decodeEffect(EnrollmentModuleKeySchema)(PORTAL_AUTH_OWNER_MODULE_KEY),
      requestDigest: Schema.decodeEffect(EnrollmentDigestSchema)(
        digestOf([
          PORTAL_AUTH_OWNER_MODULE_KEY,
          transitionKey,
          portalEnrollmentAttemptId,
          input.journey,
          normalizedEmail(input),
          input.sellingLegalEntityId,
        ]),
      ),
      transitionKey: Schema.decodeEffect(EnrollmentTransitionKeySchema)(transitionKey),
      // Four independent in-memory decodes; none reaches a shared downstream resource.
    },
    { concurrency: 4 },
  );

/** The provider account-creation transition, claimed by a Retail self-enrollment start. */
export const commercePortalAuthEnrollmentAccountCreationClaim = (
  input: CommercePortalAuthEnrollmentStartInput,
  portalEnrollmentAttemptId: string,
): Effect.Effect<CommercePortalAuthEnrollmentTransitionClaim, Schema.SchemaError> =>
  enrollmentTransitionClaim(PORTAL_ACCOUNT_CREATION_TRANSITION_KEY, input, portalEnrollmentAttemptId);

/**
 * The account-ownership proof, claimed by an Existing-account start. It creates no account: what it
 * journals is the exact subject the caller's own portal session authenticated as.
 */
export const commercePortalAuthEnrollmentAccountVerificationClaim = (
  input: CommercePortalAuthEnrollmentStartInput,
  portalEnrollmentAttemptId: string,
): Effect.Effect<CommercePortalAuthEnrollmentTransitionClaim, Schema.SchemaError> =>
  enrollmentTransitionClaim(PORTAL_ACCOUNT_VERIFICATION_TRANSITION_KEY, input, portalEnrollmentAttemptId);
