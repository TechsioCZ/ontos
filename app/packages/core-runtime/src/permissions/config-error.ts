import { Schema } from 'effect';

export class SpiceDbConfigError extends Schema.TaggedErrorClass<SpiceDbConfigError>()(
  'SpiceDbConfigError',
  {
    reason: Schema.String,
  },
) {}
