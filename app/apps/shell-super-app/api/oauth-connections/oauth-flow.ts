/**
 * Port to the Better Auth OAuth server (lane mcp-oauth-as owns the auth instance and the oauth* tables). The connect
 * and connector services only use this interface; `OAuthFlowLive` (oauth-flow-live.ts) implements it.
 */
import type { ConnectionClientKind } from '@app/shared-contracts/oauth-connections';
import { Context } from 'effect';
import type { Effect } from 'effect';

import type { ConnectionInvalid, ConnectionUnavailable } from './errors.ts';

/** The authorization request behind Better Auth's signed `oauth_query`, after signature and expiry checks. */
export interface VerifiedOAuthQuery {
  /** `?agent=` of the authorize URL, if present. */
  readonly agent: string | null;
  readonly clientId: string;
  /** `?company=` of the authorize URL, if present. */
  readonly company: string | null;
  readonly redirectUri: string;
  readonly resource: string | null;
  readonly scope: string;
  readonly state: string | null;
}

export interface OAuthClientInfo {
  readonly clientId: string;
  readonly logoUri: string | null;
  /** `client_name` of the CIMD document; the client id when the document has none. */
  readonly name: string;
}

export interface OAuthFlowService {
  /** Deletes the grant's Better Auth refresh tokens and consent rows (`reference_id` = grant id). */
  readonly deleteGrantTokens: (grantId: string) => Effect.Effect<void, ConnectionUnavailable>;
  /** Client metadata Better Auth stored for this client id; undefined when the client is unknown. */
  readonly findClient: (clientId: string) => Effect.Effect<OAuthClientInfo | undefined, ConnectionUnavailable>;
  /** Fails with `ConnectionInvalid({ code: 'oauth_query_invalid' })` for a forged or expired query. */
  readonly verifyQuery: (
    oauthQuery: string,
  ) => Effect.Effect<VerifiedOAuthQuery, ConnectionInvalid | ConnectionUnavailable>;
}

export class OAuthFlow extends Context.Service<OAuthFlow, OAuthFlowService>()(
  '@app/shell-super-app/api/oauth-connections/oauth-flow/OAuthFlow',
) {}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Host of a redirect URI for the badge (`chatgpt.com`, `claude.ai`, `localhost`); empty when unparsable. */
export const redirectHostOf = (redirectUri: string): string =>
  URL.canParse(redirectUri) ? new URL(redirectUri).hostname : '';

/** `loopback` when the client redirects to this computer, otherwise `cimd`. */
export const clientKindOf = (redirectUri: string): ConnectionClientKind =>
  LOOPBACK_HOSTS.has(redirectHostOf(redirectUri)) ? 'loopback' : 'cimd';
