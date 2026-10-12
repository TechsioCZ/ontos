import { Schema } from 'effect';

export class PrivacyActionRejected extends Schema.TaggedError<PrivacyActionRejected>()('PrivacyActionRejected', {
  code: Schema.Literal('privacy_action_rejected'),
  reason: Schema.String,
}) {}
