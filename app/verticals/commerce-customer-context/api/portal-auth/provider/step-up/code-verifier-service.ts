import { Context } from 'effect';
import type { Effect } from 'effect';

import type { CommercePortalAuthStepUpCodeInput } from './contracts.ts';
import type { CommercePortalAuthStepUpCodeRejected } from './code-rejected.ts';
import type { CommercePortalAuthStepUpUnavailable } from './unavailable.ts';

/**
 * Owner-local seam for the installed MFA provider. Better Auth's verifyTOTP response is projected
 * away by the adapter; this port returns only whether the code was accepted for the current cookie.
 */
export interface CommercePortalAuthStepUpCodeVerifier {
  readonly verify: (
    input: CommercePortalAuthStepUpCodeInput,
  ) => Effect.Effect<void, CommercePortalAuthStepUpCodeRejected | CommercePortalAuthStepUpUnavailable>;
}

export class CommercePortalAuthStepUpCodeVerifierService extends Context.Service<
  CommercePortalAuthStepUpCodeVerifierService,
  CommercePortalAuthStepUpCodeVerifier
>()(
  '@app/commerce-customer-context/api/portal-auth/provider/step-up/code-verifier-service/CommercePortalAuthStepUpCodeVerifierService',
) {}
