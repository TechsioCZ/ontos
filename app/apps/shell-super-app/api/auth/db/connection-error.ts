import { Schema } from 'effect';

export class AuthDatabaseConnectionError extends Schema.TaggedErrorClass<AuthDatabaseConnectionError>()(
  'AuthDatabaseConnectionError',
  {
    reason: Schema.String,
  },
) {}
