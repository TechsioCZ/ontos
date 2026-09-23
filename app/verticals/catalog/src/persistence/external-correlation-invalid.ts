import { Schema } from 'effect';

export class ExternalCorrelationInvalid extends Schema.TaggedError<ExternalCorrelationInvalid>()(
  'ExternalCorrelationInvalid',
  { reason: Schema.String },
) {}
