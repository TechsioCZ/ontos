import { Schema } from 'effect';

export class ExternalCorrelationUnverifiable extends Schema.TaggedError<ExternalCorrelationUnverifiable>()(
  'ExternalCorrelationUnverifiable',
  { reason: Schema.String },
) {}
