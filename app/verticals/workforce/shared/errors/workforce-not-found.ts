import { Schema } from 'effect';

export class WorkforceNotFound extends Schema.TaggedError<WorkforceNotFound>()('WorkforceNotFound', {
  code: Schema.Literal('workforce_not_found'),
  reason: Schema.String,
}) {}
