import { Schema } from 'effect';

export class PurposeVersionConflict extends Schema.TaggedError<PurposeVersionConflict>()('PurposeVersionConflict', {
  code: Schema.Literal('privacy_purpose_version_conflict'),
  reason: Schema.String,
}) {}
