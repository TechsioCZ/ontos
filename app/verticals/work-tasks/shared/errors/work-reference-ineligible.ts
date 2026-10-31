import { Schema } from 'effect';

export class WorkReferenceIneligible extends Schema.TaggedError<WorkReferenceIneligible>()('WorkReferenceIneligible', {
  code: Schema.Literal('work_reference_ineligible'),
  reason: Schema.String,
}) {}
