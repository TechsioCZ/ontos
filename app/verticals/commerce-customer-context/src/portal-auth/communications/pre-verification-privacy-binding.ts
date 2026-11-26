import { BindPreVerificationSubjectResultSchema } from '@app/privacy/actions/bind-pre-verification-subject';
import type { BindPreVerificationSubjectPayloadSchema } from '@app/privacy/actions/bind-pre-verification-subject';
import type { CommunicationRequestEncoded } from '@app/communications-contracts/communication-request';
import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect';

import {
  PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE,
  PORTAL_AUTH_RESOURCE_TYPE,
  portalAuthCommunicationPurposeOf,
} from '../../../shared/portal-auth-communications.ts';
import type { PortalAuthIssuance } from './issuance.ts';
import { CommercePortalAuthPreVerificationPrivacyTransport } from './pre-verification-privacy-transport.ts';
import type { PreVerificationPrivacyTransportService } from './pre-verification-privacy-transport.ts';
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

/**
 * The same bind request, as the relayed Communication Request of the issuance states it (#1406): the occurrence is the
 * issuance with its expiry, the original recipient is Auth's own account reference and the purpose is the flow's Auth purpose.
 * A request that names no Portal Auth account recipient or no expiry has nothing to bind.
 */
export const preVerificationBindPayloadOfRequest = (
  request: CommunicationRequestEncoded,
): Option.Option<typeof BindPreVerificationSubjectPayloadSchema.Encoded> => {
  const [recipient] = request.originalRecipients;
  const { validUntil } = request.occurrence;
  if (
    recipient === undefined ||
    validUntil === undefined ||
    recipient.recipientRef.moduleId !== PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE ||
    recipient.recipientRef.resourceType !== PORTAL_AUTH_RESOURCE_TYPE.account
  ) {
    return Option.none();
  }
  return Option.some({
    occurrence: { occurrenceId: request.occurrence.occurrenceId, validUntil },
    source: {
      moduleId: PORTAL_AUTH_COMMUNICATION_SOURCE_MODULE,
      resourceId: recipient.recipientRef.resourceId,
      resourceType: PORTAL_AUTH_RESOURCE_TYPE.account,
    },
    sourcePurposeRef: request.purpose,
  });
};

const decodeBinding = Schema.decodeUnknownEffect(BindPreVerificationSubjectResultSchema);

/**
 * Privacy's public bind Action over one way of asking it. Only Privacy's own answer, read with Privacy's published result
 * schema, is a binding; anything else is `PRIVACY_UNAVAILABLE`. A subject Privacy withdrew is still returned as Privacy
 * reported it, so Privacy's eligibility answers NOT_ALLOWED for it later.
 */
export const bindPreVerificationSubjectBy =
  (askPrivacy: PreVerificationPrivacyTransportService['bind']) =>
  (payload: typeof BindPreVerificationSubjectPayloadSchema.Encoded) =>
    askPrivacy(payload).pipe(
      Effect.flatMap(decodeBinding),
      Effect.catchTag('SchemaError', (cause) =>
        Effect.fail(
          Object.defineProperty(
            new PreVerificationPrivacyBindingUnavailable({ reason: 'PRIVACY_UNAVAILABLE' }),
            'cause',
            {
              enumerable: false,
              value: cause,
            },
          ),
        ),
      ),
    );

/** Auth's binding of an issuance over the composed transport (`bindPreVerificationSubjectBy`). */
export const privacyPreVerificationBindingLayer = Layer.effect(
  CommercePortalAuthPreVerificationPrivacyBinding,
  Effect.gen(function* privacyBinding() {
    const transport = yield* CommercePortalAuthPreVerificationPrivacyTransport;
    const bindPayload = bindPreVerificationSubjectBy(transport.bind);
    return {
      bind: (issuance: PortalAuthIssuance) => bindPayload(preVerificationBindPayloadOf(issuance)),
    };
  }),
);

/**
 * A composition without a transport to Privacy: Auth cannot evidence the binding, so the message stops as `not-sent` with the
 * distinct Privacy reason, and no Subject or Party is invented. Production binds through the module's source worker instead
 * (`workers/portal-auth-pre-verification-privacy-gateway.ts`).
 */
export const unsupportedPreVerificationPrivacyBindingLayer = Layer.succeed(
  CommercePortalAuthPreVerificationPrivacyBinding,
  { bind: () => Effect.fail(new PreVerificationPrivacyBindingUnavailable({ reason: 'NO_SUPPORTED_PRIVACY_PATH' })) },
);
