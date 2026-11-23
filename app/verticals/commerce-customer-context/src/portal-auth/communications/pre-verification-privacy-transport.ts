import type { BindPreVerificationSubjectPayloadSchema } from '@app/privacy/actions/bind-pre-verification-subject';
import { Context, Effect, Layer } from 'effect';

import { PreVerificationPrivacyBindingUnavailable } from './privacy-binding-unavailable.ts';

/**
 * How ONE bind request reaches Privacy's public Action. The user-triggered Auth flows have no authenticated principal after
 * the commit to call a protected Action under, exactly as for the Communication Request itself, so production binds over the
 * same path as the request: the Auth-local outbox, the relay and the module's source worker, whose registered-workload
 * transport is `workers/portal-auth-pre-verification-privacy-gateway.ts`. A transport answers with Privacy's response as
 * received, or fails with `PRIVACY_REFUSED` (Privacy's published refusal) or `PRIVACY_UNAVAILABLE` (no answer).
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
  '@app/commerce-customer-context/portal-auth/communications/pre-verification-privacy-transport/CommercePortalAuthPreVerificationPrivacyTransport',
) {}

/** A composition with no path to Privacy (tests, a deployment without the relay): nothing is bound and nothing is sent. */
export const unavailablePreVerificationPrivacyTransportLayer = Layer.succeed(
  CommercePortalAuthPreVerificationPrivacyTransport,
  { bind: () => Effect.fail(new PreVerificationPrivacyBindingUnavailable({ reason: 'NO_SUPPORTED_PRIVACY_PATH' })) },
);
