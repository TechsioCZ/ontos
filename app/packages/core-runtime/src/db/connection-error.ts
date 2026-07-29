import { Schema } from 'effect';

export class DatabaseConnectionError extends Schema.TaggedErrorClass<DatabaseConnectionError>()(
  'DatabaseConnectionError',
  {
    reason: Schema.String,
  },
) {}
