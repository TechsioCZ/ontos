import { Schema } from 'effect';

export class AuthDatabaseConnectionError extends Schema.TaggedError<AuthDatabaseConnectionError>()(
  'AuthDatabaseConnectionError',
  {
    reason: Schema.String,
  },
) {}
