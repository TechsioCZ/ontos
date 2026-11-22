import { BindPreVerificationSubjectResultSchema } from '@app/privacy/actions/bind-pre-verification-subject';
import type { BindPreVerificationSubjectPayloadSchema } from '@app/privacy/actions/bind-pre-verification-subject';
import { Context, DateTime, Effect, Layer, Schema } from 'effect';

import {
  PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE,
  PORTAL_AUTH_RESOURCE_TYPE,
  portalAuthCommunicationPurposeOf,
} from '../../../shared/portal-auth-communications.ts';
import type { PortalAuthIssuance } from './issuance.ts';
import { CommercePortalAuthPreVerificationPrivacyTransport } from './pre-verification-privacy-transport.ts';
import { PreVerificationPrivacyBindingUnavailable } from './privacy-binding-unavailable.ts';

/**
 * The Privacy side of a Portal Auth message BEFORE the address is verified (#1406 D.8). Privacy binds the subject: Auth
 * asks its public `bind-pre-verification-subject` Action with Auth's OWN account reference (the provider subject id),
 * the Auth purpose of the flow and the issuance with its expiry, and nothing else (no address, token, link or code).
 * Privacy answers with its own subject identity and the exact scope its policy allows, or binds nothing; a locator Auth
 * asserts, an e-mail match, a presumed Party or an anonymous browser context is never a substitute.
 *
 * The binding is Tenant-scoped: a Tenant-wide realm binds without a Legal Entity and is never given one.
 */
export interface PreVerificationPrivacyBindingService {
  readonly bind: (
    issuance: PortalAuthIssuance,
  ) => Effect.Effect<typeof BindPreVerificationSubjectResultSchema.Type, PreVerificationPrivacyBindingUnavailable>;
}

export class CommercePortalAuthPreVerificationPrivacyBinding extends Context.Service<
  CommercePortalAuthPreVerificationPrivacyBinding,
  PreVerificationPrivacyBindingService
>()(
  '@app/commerce-customer-context/portal-auth/communications/pre-verification-privacy-binding/CommercePortalAuthPreVerificationPrivacyBinding',
) {}

/** The bind request of one issuance: Auth's own account reference, the flow's Auth purpose and the issuance expiry. */
export const preVerificationBindPayloadOf = (
  issuance: PortalAuthIssuance,
): typeof BindPreVerificationSubjectPayloadSchema.Encoded => ({
  occurrence: { occurrenceId: issuance.issuanceRef, validUntil: DateTime.formatIso(issuance.expiresAt) },
  source: {
    moduleId: PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE,
    resourceId: issuance.providerSubjectId,
    resourceType: PORTAL_AUTH_RESOURCE_TYPE.account,
  },
  sourcePurposeRef: portalAuthCommunicationPurposeOf(issuance.flow),
});

const decodeBinding = Schema.decodeUnknownEffect(BindPreVerificationSubjectResultSchema);

/**
 * Auth's production binding: Privacy's public bind Action over the composed transport. Only Privacy's own answer, read
 * with Privacy's published result schema, is a binding; anything else is `PRIVACY_UNAVAILABLE`. A subject Privacy
 * withdrew is still returned as Privacy reported it, so Privacy's eligibility answers NOT_ALLOWED for it later.
 */
export const privacyPreVerificationBindingLayer = Layer.effect(
  CommercePortalAuthPreVerificationPrivacyBinding,
  Effect.gen(function* privacyBinding() {
    const transport = yield* CommercePortalAuthPreVerificationPrivacyTransport;
    return {
      bind: Effect.fn('CommercePortalAuthPreVerificationPrivacyBinding.bind')(function* bind(
        issuance: PortalAuthIssuance,
      ) {
        const answer = yield* transport.bind(preVerificationBindPayloadOf(issuance));
        return yield* decodeBinding(answer).pipe(
          Effect.mapError((cause) =>
            Object.defineProperty(
              new PreVerificationPrivacyBindingUnavailable({ reason: 'PRIVACY_UNAVAILABLE' }),
              'cause',
              {
                enumerable: false,
                value: cause,
              },
            ),
          ),
        );
      }),
    };
  }),
);

/**
 * A composition without a transport to Privacy (today's production, D1): Auth cannot evidence the binding, so the message
 * stops as `not-sent` with the distinct Privacy reason, and no Subject or Party is invented.
 */
export const unsupportedPreVerificationPrivacyBindingLayer = Layer.succeed(
  CommercePortalAuthPreVerificationPrivacyBinding,
  { bind: () => Effect.fail(new PreVerificationPrivacyBindingUnavailable({ reason: 'NO_SUPPORTED_PRIVACY_PATH' })) },
);
