import { Schema } from 'effect';

export class ActivityScopeMismatch extends Schema.TaggedError<ActivityScopeMismatch>()('ActivityScopeMismatch', {
  code: Schema.Literal('activity_scope_mismatch'),
  reason: Schema.String,
}) {}
