import { Schema } from 'effect';

export class ExternalCorrelationTargetTypeMismatch extends Schema.TaggedError<ExternalCorrelationTargetTypeMismatch>()(
  'ExternalCorrelationTargetTypeMismatch',
  { reason: Schema.String },
) {}
