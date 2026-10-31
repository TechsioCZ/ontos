import { Schema } from 'effect';

export class WorkforceScopeMismatch extends Schema.TaggedError<WorkforceScopeMismatch>()('WorkforceScopeMismatch', {
  code: Schema.Literal('workforce_scope_mismatch'),
  reason: Schema.String,
}) {}
