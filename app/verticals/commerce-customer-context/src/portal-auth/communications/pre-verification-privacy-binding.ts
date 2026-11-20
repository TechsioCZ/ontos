import { Context, Effect, Layer } from 'effect';

import type { PortalAuthIssuance } from './issuance.ts';
import { PreVerificationPrivacyBindingUnavailable } from './privacy-binding-unavailable.ts';

/**
 * The Privacy side of a Portal Auth message BEFORE the address is verified (#1406 D.8). A supported Privacy path must
 * bind the subject, the exact purpose and version, the operation, the Tenant and the Legal Entity first; a locator the
 * source asserts, an e-mail match, a presumed Party or an anonymous browser context is no proof of identity or permission.
 *
 * The current Privacy owner contract cannot represent that binding (it needs an existing `subjectRef` and answers only a
 * limited consumer list), so the only production composition is the fail-closed one below: Auth cannot evidence the
 * binding, the message stops as `not-sent` with the distinct Privacy reason, and no Subject or Party is invented.
 */
export interface PreVerificationPrivacyBindingService {
  readonly bind: (
    issuance: PortalAuthIssuance,
  ) => Effect.Effect<
    { readonly bindingRef: string; readonly purposeVersion: string },
    PreVerificationPrivacyBindingUnavailable
  >;
}

export class CommercePortalAuthPreVerificationPrivacyBinding extends Context.Service<
  CommercePortalAuthPreVerificationPrivacyBinding,
  PreVerificationPrivacyBindingService
>()(
  '@app/commerce-customer-context/portal-auth/communications/pre-verification-privacy-binding/CommercePortalAuthPreVerificationPrivacyBinding',
) {}

export const unsupportedPreVerificationPrivacyBindingLayer = Layer.succeed(
  CommercePortalAuthPreVerificationPrivacyBinding,
  { bind: () => Effect.fail(new PreVerificationPrivacyBindingUnavailable({ reason: 'NO_SUPPORTED_PRIVACY_PATH' })) },
);
