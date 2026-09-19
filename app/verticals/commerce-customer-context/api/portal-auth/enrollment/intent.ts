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

/**
 * The durable intent the `start-portal-enrollment` Action records. `intentKey` names the journey
 * so two journeys never share an Attempt; `intentDigest` is what makes an equivalent retry
 * idempotent.
 */
export const commercePortalAuthEnrollmentIntent = (
  input: CommercePortalAuthEnrollmentStartInput,
): Effect.Effect<StartPortalEnrollmentPayload, Schema.SchemaError> =>
  Effect.all(
    {
      intentDigest: Schema.decodeEffect(EnrollmentDigestSchema)(
        digestOf([
          input.journey,
          input.email.trim().toLowerCase(),
          input.sellingLegalEntityId,
          input.invitationId ?? '',
          input.partyRef ?? '',
        ]),
      ),
      intentKey: Schema.decodeEffect(EnrollmentKeySchema)(
        `${ENROLLMENT_INTENT_KEY_PREFIX}.${input.journey.toLowerCase()}`,
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
      const withInvitation = input.invitationId === undefined ? base : { ...base, invitationId: input.invitationId };
      return input.partyRef === undefined ? withInvitation : { ...withInvitation, targetResourceId: input.partyRef };
    }),
  );

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
          input.email.trim().toLowerCase(),
          input.sellingLegalEntityId,
        ]),
      ),
      transitionKey: Schema.decodeEffect(EnrollmentTransitionKeySchema)(PORTAL_ACCOUNT_CREATION_TRANSITION_KEY),
      // Four independent in-memory decodes; none reaches a shared downstream resource.
    },
    { concurrency: 4 },
  );
