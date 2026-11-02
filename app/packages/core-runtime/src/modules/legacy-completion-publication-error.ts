import { Schema } from 'effect';

export class LegacyCompletionPublicationError extends Schema.TaggedError<LegacyCompletionPublicationError>()(
  'LegacyCompletionPublicationError',
  { cause: Schema.optionalKey(Schema.Defect()), reason: Schema.String },
) {}
