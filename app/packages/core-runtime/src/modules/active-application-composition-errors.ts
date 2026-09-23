import { Schema } from 'effect';

export class ActiveApplicationCompositionUnavailableError extends Schema.TaggedError<ActiveApplicationCompositionUnavailableError>()(
  'ActiveApplicationCompositionUnavailableError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    code: Schema.tag('active_application_composition_unavailable'),
    reason: Schema.String,
  },
) {}
