import { readVerifiedGatewayActor, ReadPermissionDenied } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Effect } from 'effect';

/**
 * The Privacy owner Reads answer Privacy only, as the verified calling module of its requester. Core's gate decides the
 * requester's own grant of the Read's declaration and admits no other calling module; this binds the call to that
 * delegated form, so a direct staff call is refused even when the person holds the capability.
 */
export const requirePrivacyCaller = Effect.fn('Communications.requirePrivacyCaller')(function* requirePrivacyCaller(
  scope: OperationalScope,
) {
  if (readVerifiedGatewayActor(scope)?.appId !== 'privacy') {
    return yield* new ReadPermissionDenied({
      code: 'read_permission_denied',
      reason: 'Only Privacy, as the verified calling module of its requester, may ask the Communications owner',
    });
  }
  return yield* Effect.void;
});
