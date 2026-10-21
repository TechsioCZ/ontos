// @effect-diagnostics asyncFunction:off -- Better Auth calls these OAuth hooks as Promise callbacks. expires: 2027-03-31.
/**
 * Real Better Auth OAuth hooks of the MCP connection grant (replaces `stubOAuthConnectionHooks` in
 * api/auth/oauth-server/connection-hooks.ts). The grant id is the consent reference and the access-token claim.
 */
import { OAUTH_GRANT_CLAIM } from '@app/shared-contracts/oauth-connections';
import { Effect, Layer } from 'effect';

import { AuthDatabase } from '../auth/db/client.ts';
import { type OAuthConnectionHooksContract, OAuthConnectionHooks } from '../auth/oauth-server/connection-hooks.ts';
import { findSessionGrant } from './grant-store.ts';

export const makeOAuthConnectionHooks = (database: (typeof AuthDatabase)['Service']): OAuthConnectionHooksContract => {
  const sessionGrant = (session: { readonly id: string; readonly userId: string }) =>
    Effect.runPromise(
      findSessionGrant({ sessionId: session.id, userId: session.userId }).pipe(
        Effect.provideService(AuthDatabase, database),
      ),
    );
  return {
    consentReferenceId: async ({ session }) => {
      const grant = await sessionGrant(session);
      if (grant === undefined) {
        throw new Error('oauth_connection_draft_missing');
      }
      return grant.grantId;
    },
    customAccessTokenClaims: async ({ referenceId }) => {
      if (referenceId === undefined || referenceId.length === 0) {
        throw new Error('oauth_connection_grant_missing');
      }
      return { [OAUTH_GRANT_CLAIM]: referenceId };
    },
    shouldRedirect: async ({ isContinuation, session }) =>
      !isContinuation || (await sessionGrant(session)) === undefined,
  };
};

/** Real hooks for lane mcp-oauth-as (replaces `stubOAuthConnectionHooks`). */
export const OAuthConnectionHooksLive = Layer.effect(
  OAuthConnectionHooks,
  AuthDatabase.pipe(Effect.map(makeOAuthConnectionHooks)),
);
