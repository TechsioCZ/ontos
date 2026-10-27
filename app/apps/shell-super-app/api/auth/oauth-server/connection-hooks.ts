/**
 * Native hooks for the MCP connection grant (ONTOS-MCP-AUTH-DESIGN.md §2.1, §3.1).
 *
 * Better Auth calls consentReferenceId before consent, on approval and again when issuing the code. Each call must
 * resolve the retained draft or active grant for the current session. Refresh keeps this referenceId for token claims.
 * Only better-auth-framework.ts converts these Effects to the SDK's callbacks, using the serving request's Context.
 */
import type { OAuthGrantRegistryUnavailable } from '@app/core-runtime';
import type { OAUTH_GRANT_CLAIM } from '@app/shared-contracts/oauth-connections';
import type { McpOptions } from '@better-auth/mcp';
import { Context } from 'effect';
import type { Effect } from 'effect';

import type { ConnectionInvalid } from '../../oauth-connections/errors.ts';

/** Keep only the SDK fields consumed by the native hooks, without its extensible user/session dictionaries. */
type ConsentContext = Parameters<NonNullable<McpOptions['postLogin']>['consentReferenceId']>[0];

export interface OAuthConsentReferenceContext {
  readonly session: Pick<ConsentContext['session'], 'id' | 'userId'>;
}

export interface OAuthPostLoginContext
  extends
    OAuthConsentReferenceContext,
    Pick<Parameters<NonNullable<McpOptions['postLogin']>['shouldRedirect']>[0], 'isContinuation'> {}

export type OAuthAccessTokenClaimsInput = Pick<
  Parameters<NonNullable<McpOptions['customAccessTokenClaims']>>[0],
  'referenceId'
>;

export interface OAuthConnectionHooksContract {
  /** The real retained grant id of this session's connect flow; fail when there is none. */
  readonly consentReferenceId: (
    context: OAuthConsentReferenceContext,
  ) => Effect.Effect<string, ConnectionInvalid | OAuthGrantRegistryUnavailable>;
  /** The exact consent reference carried by both issued and refreshed access tokens. */
  readonly customAccessTokenClaims: (
    input: OAuthAccessTokenClaimsInput,
  ) => Effect.Effect<Readonly<Record<typeof OAUTH_GRANT_CLAIM, string>>, ConnectionInvalid>;
  /** Fresh logins and continuations without a retained grant must visit the connect page. */
  readonly shouldRedirect: (context: OAuthPostLoginContext) => Effect.Effect<boolean, OAuthGrantRegistryUnavailable>;
}

export class OAuthConnectionHooks extends Context.Service<OAuthConnectionHooks, OAuthConnectionHooksContract>()(
  '@app/shell-super-app/api/auth/oauth-server/connection-hooks/OAuthConnectionHooks',
) {}
