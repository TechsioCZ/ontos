import { Schema } from 'effect';

export class WorkforceReferenceUnavailable extends Schema.TaggedError<WorkforceReferenceUnavailable>()(
  'WorkforceReferenceUnavailable',
  {
    code: Schema.Literal('workforce_reference_unavailable'),
    reason: Schema.String,
  },
) {}
