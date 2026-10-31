import { Schema } from 'effect';

export class WorkforceRevisionConflict extends Schema.TaggedError<WorkforceRevisionConflict>()(
  'WorkforceRevisionConflict',
  {
    code: Schema.Literal('workforce_revision_conflict'),
    reason: Schema.String,
  },
) {}
