import { Schema } from 'effect';

export class WorkNotFound extends Schema.TaggedError<WorkNotFound>()('WorkNotFound', {
  code: Schema.Literal('work_not_found'),
  reason: Schema.String,
}) {}
