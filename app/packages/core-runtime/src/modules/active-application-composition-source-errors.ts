import { Schema } from 'effect';

export class ActiveApplicationCompositionSourceReadError extends Schema.TaggedError<ActiveApplicationCompositionSourceReadError>()(
  'ActiveApplicationCompositionSourceReadError',
  { cause: Schema.optionalKey(Schema.Defect()), reason: Schema.String },
) {}
