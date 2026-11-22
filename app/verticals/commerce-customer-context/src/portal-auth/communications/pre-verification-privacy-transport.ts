import type { BindPreVerificationSubjectPayloadSchema } from '@app/privacy/actions/bind-pre-verification-subject';
import { Context, Effect, Layer } from 'effect';

import { PreVerificationPrivacyBindingUnavailable } from './privacy-binding-unavailable.ts';

/**
 * How ONE bind request reaches Privacy's public Action. The transport is the composition's decision and it is OPEN
 * (D1): the user-triggered Auth flows have no authenticated principal after the commit to call a protected Action under,
 * exactly as for the Communication Request itself. A transport answers with Privacy's response as received, or fails
 * with `PRIVACY_REFUSED` (Privacy's published refusal) or `PRIVACY_UNAVAILABLE` (no answer).
 */
export interface PreVerificationPrivacyTransportService {
  readonly bind: (
    payload: typeof BindPreVerificationSubjectPayloadSchema.Encoded,
  ) => Effect.Effect<unknown, PreVerificationPrivacyBindingUnavailable>;
}

export class CommercePortalAuthPreVerificationPrivacyTransport extends Context.Service<
  CommercePortalAuthPreVerificationPrivacyTransport,
  PreVerificationPrivacyTransportService
>()(
  '@app/commerce-customer-context/portal-auth/communications/pre-verification-privacy-binding/CommercePortalAuthPreVerificationPrivacyTransport',
) {}

/** The only production transport until D1 is resolved: no path to Privacy, so nothing is bound and nothing is sent. */
export const unavailablePreVerificationPrivacyTransportLayer = Layer.succeed(
  CommercePortalAuthPreVerificationPrivacyTransport,
  { bind: () => Effect.fail(new PreVerificationPrivacyBindingUnavailable({ reason: 'NO_SUPPORTED_PRIVACY_PATH' })) },
);
