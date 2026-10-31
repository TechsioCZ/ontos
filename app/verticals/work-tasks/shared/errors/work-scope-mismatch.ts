import { Schema } from 'effect';

export class WorkScopeMismatch extends Schema.TaggedError<WorkScopeMismatch>()('WorkScopeMismatch', {
  code: Schema.Literal('work_scope_mismatch'),
  reason: Schema.String,
}) {}
