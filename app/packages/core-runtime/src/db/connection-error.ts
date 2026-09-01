import { Schema } from 'effect';

export class DatabaseConnectionError extends Schema.TaggedError<DatabaseConnectionError>()(
  'DatabaseConnectionError',
  {
    reason: Schema.String,
  },
) {}
