import { Effect, Layer } from 'effect';

import { CommercePortalAuthStepUpUnavailable } from './unavailable.ts';
import { CommercePortalAuthStepUpHttpProviderService } from './http.ts';

const CURRENT_SESSION_READ_OPERATION = 'current-session-read';
const COOKIE_HANDOFF_OPERATION = 'cookie-handoff';

const unavailable = (operation: string): CommercePortalAuthStepUpUnavailable =>
  new CommercePortalAuthStepUpUnavailable({
    operation,
    reason: 'Commerce portal step-up provider is not installed in this deployment',
  });

/**
 * The step-up transport needs a provider boundary that reads the current provider session and
 * signs the private lifecycle cookie handoff. No implementation of that boundary exists in this
 * repository yet — the wave-2 design records it as lane-11 finding R11-4 (`setSessionCookie` has
 * no `Live` anywhere) and puts it explicitly out of wave-2 scope, so nothing here mints a
 * provider session cookie.
 *
 * The composed Commerce runtime still has to declare a handler for every group its API publishes,
 * so the step-up routes are mounted against this leaf: both operations fail closed with the
 * owner's retryable 503 problem rather than being silently absent or, worse, issuing a challenge
 * that can never be completed. This mirrors the owner-port leaves the same composition root
 * already installs (`profileReconfirmationPolicyUnavailableLive`,
 * `ProfileReconciliationOwnerVerifierUnavailableLive`). Replace it with the real provider when the
 * cookie handoff lands; no other file has to change.
 */
export const CommercePortalAuthStepUpHttpProviderUnavailableLive = Layer.succeed(
  CommercePortalAuthStepUpHttpProviderService,
  {
    readCurrentSession: () => Effect.fail(unavailable(CURRENT_SESSION_READ_OPERATION)),
    setSessionCookie: () => Effect.fail(unavailable(COOKIE_HANDOFF_OPERATION)),
  },
);
