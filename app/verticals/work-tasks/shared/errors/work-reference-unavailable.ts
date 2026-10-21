import { Schema } from 'effect';

export class WorkReferenceUnavailable extends Schema.TaggedError<WorkReferenceUnavailable>()(
  'WorkReferenceUnavailable',
  {
    code: Schema.Literal('work_reference_unavailable'),
    reason: Schema.String,
  },
) {}
