import { Schema } from 'effect';

export class SpiceDbConfigError extends Schema.TaggedError<SpiceDbConfigError>()(
  'SpiceDbConfigError',
  {
    reason: Schema.String,
  },
) {}
