/** Native connection hooks resolve the retained grant through the request-owned issuer registry. */
import { OAuthGrantRegistry } from '@app/core-runtime';
import { OAUTH_GRANT_CLAIM } from '@app/shared-contracts/oauth-connections';
import { Effect, Layer, Option } from 'effect';

import { OAuthConnectionHooks } from '../auth/oauth-server/connection-hooks.ts';
import type {
  OAuthAccessTokenClaimsInput,
  OAuthConnectionHooksContract,
  OAuthConsentReferenceContext,
  OAuthPostLoginContext,
} from '../auth/oauth-server/connection-hooks.ts';
import { ConnectionInvalid } from './errors.ts';

export const makeOAuthConnectionHooks = Effect.fn('OAuthConnectionHooks.make')(function* makeOAuthConnectionHooks() {
  const registry = yield* OAuthGrantRegistry;
  const sessionGrant = (session: OAuthConsentReferenceContext['session']) =>
    registry.findSessionGrant({ sessionId: session.id, userId: session.userId });
  const consentReferenceId = Effect.fn('OAuthConnectionHooks.consentReferenceId')(function* consentReferenceId(
    input: OAuthConsentReferenceContext,
  ) {
    const grant = yield* sessionGrant(input.session);
    if (Option.isNone(grant)) {
      return yield* new ConnectionInvalid({ code: 'draft_not_found' });
    }
    return grant.value.grantId;
  });
  const customAccessTokenClaims = Effect.fn('OAuthConnectionHooks.customAccessTokenClaims')(
    function* customAccessTokenClaims(input: OAuthAccessTokenClaimsInput) {
      if (input.referenceId === undefined || input.referenceId.length === 0) {
        return yield* new ConnectionInvalid({ code: 'grant_not_found' });
      }
      return { [OAUTH_GRANT_CLAIM]: input.referenceId };
    },
  );
  const shouldRedirect = Effect.fn('OAuthConnectionHooks.shouldRedirect')(function* shouldRedirect(
    input: OAuthPostLoginContext,
  ) {
    return !input.isContinuation || Option.isNone(yield* sessionGrant(input.session));
  });
  return { consentReferenceId, customAccessTokenClaims, shouldRedirect } satisfies OAuthConnectionHooksContract;
});

export const OAuthConnectionHooksLive = Layer.effect(OAuthConnectionHooks, makeOAuthConnectionHooks());
