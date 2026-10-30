import { Data, Schema } from 'effect';

const ConnectionUnauthorizedCodeSchema = Schema.Literals([
  'agent_disabled',
  'binding_inactive',
  'connector_key_invalid',
  'grant_inactive',
  'membership_missing',
  'operator_removed',
  'principal_inactive',
  'session_missing',
  'token_invalid',
  'token_missing',
  'user_disabled',
]);
export type ConnectionUnauthorizedCode = typeof ConnectionUnauthorizedCodeSchema.Type;

/** Missing credentials or an inactive grant. The code is for logs only. */
export class ConnectionUnauthorized extends Data.TaggedError('ConnectionUnauthorized')<{
  readonly code: ConnectionUnauthorizedCode;
}> {}
