import { Schema } from 'effect';

export class CommerceSourceProcessingRejected extends Schema.TaggedError<CommerceSourceProcessingRejected>()(
  'CommerceSourceProcessingRejected',
  { code: Schema.Literals(['DENIED', 'UNAVAILABLE']), reason: Schema.String },
) {}
