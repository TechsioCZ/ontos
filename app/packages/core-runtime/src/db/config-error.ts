import { Schema } from 'effect';

export class DatabaseConfigError extends Schema.TaggedError<DatabaseConfigError>()(
  'DatabaseConfigError',
  {
    reason: Schema.String,
  },
) {}
