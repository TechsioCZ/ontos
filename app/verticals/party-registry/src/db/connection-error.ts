import { Schema } from 'effect';

export class PartyDatabaseConnectionError extends Schema.TaggedError<PartyDatabaseConnectionError>()(
  'PartyDatabaseConnectionError',
  {
    reason: Schema.String,
  },
) {}
