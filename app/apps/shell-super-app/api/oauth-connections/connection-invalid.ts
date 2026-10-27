import { Data } from 'effect';

/** A forged/expired query, malformed modules, or a missing or already approved draft. */
export class ConnectionInvalid extends Data.TaggedError('ConnectionInvalid')<{
  readonly code:
    | 'connection_active'
    | 'draft_not_found'
    | 'grant_not_found'
    | 'modules_invalid'
    | 'oauth_query_invalid';
}> {}
