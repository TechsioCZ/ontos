import { Schema } from 'effect';

export class DatabaseConfigError extends Schema.TaggedErrorClass<DatabaseConfigError>()(
  'DatabaseConfigError',
  {
    reason: Schema.String,
  },
) {}
