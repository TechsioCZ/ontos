import { Schema } from 'effect';

export class WorkforceReferenceIneligible extends Schema.TaggedError<WorkforceReferenceIneligible>()(
  'WorkforceReferenceIneligible',
  {
    code: Schema.Literal('workforce_reference_ineligible'),
    reason: Schema.String,
  },
) {}
