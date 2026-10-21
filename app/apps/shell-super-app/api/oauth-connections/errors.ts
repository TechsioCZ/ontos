/**
 * Errors of the OAuth connection grant (lane mcp-connection-grants). HTTP mapping used by connect-http.ts and
 * connector-http.ts: Unavailable 503, Unauthorized 401 (connector: `WWW-Authenticate: Bearer error="invalid_token"`),
 * Forbidden 403, Invalid 400 (`oauth_query_invalid`) or 404 (`draft_not_found`, `grant_not_found`).
 */
import { Data } from 'effect';

/** Database, SpiceDB or catalog failure. */
export class ConnectionUnavailable extends Data.TaggedError('ConnectionUnavailable')<{ readonly cause: unknown }> {}

export type ConnectionUnauthorizedCode =
  | 'agent_disabled'
  | 'binding_inactive'
  | 'connector_key_invalid'
  | 'grant_inactive'
  | 'membership_missing'
  | 'operator_removed'
  | 'principal_inactive'
  | 'session_missing'
  | 'token_invalid'
  | 'token_missing'
  | 'user_disabled';

/** Missing/invalid connector secret, user token, session or an inactive grant. `code` is for logs only. */
export class ConnectionUnauthorized extends Data.TaggedError('ConnectionUnauthorized')<{
  readonly code: ConnectionUnauthorizedCode;
}> {}

/** Authenticated but not allowed. `code` is a `ConnectProblemCode`; `reason` is Czech and shown to the person. */
export class ConnectionForbidden extends Data.TaggedError('ConnectionForbidden')<{
  readonly code: string;
  readonly reason: string;
}> {}

/** Expired/forged signed OAuth query, unknown draft or grant, or a malformed module list. */
export class ConnectionInvalid extends Data.TaggedError('ConnectionInvalid')<{
  readonly code: 'draft_not_found' | 'grant_not_found' | 'modules_invalid' | 'oauth_query_invalid';
}> {}
