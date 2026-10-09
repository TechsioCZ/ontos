import { Schema } from 'effect';

export class PurposeNotFound extends Schema.TaggedError<PurposeNotFound>()('PurposeNotFound', {
  code: Schema.Literal('privacy_purpose_not_found'),
  reason: Schema.String,
}) {}
