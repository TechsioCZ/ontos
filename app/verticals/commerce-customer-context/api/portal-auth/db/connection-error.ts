import { Schema } from 'effect';

export class CommercePortalAuthDatabaseConnectionError extends Schema.TaggedError<CommercePortalAuthDatabaseConnectionError>()(
  'CommercePortalAuthDatabaseConnectionError',
  {
    reason: Schema.String,
  },
) {}
