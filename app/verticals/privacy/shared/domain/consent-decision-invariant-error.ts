import { Schema } from 'effect';

export class ConsentDecisionInvariantError extends Schema.TaggedError<ConsentDecisionInvariantError>()(
  'ConsentDecisionInvariantError',
  { reason: Schema.String },
) {}
