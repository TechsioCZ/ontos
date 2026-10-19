import { Schema } from 'effect';

export class SiamparkOpsRevisionConflict extends Schema.TaggedError<SiamparkOpsRevisionConflict>()(
  'SiamparkOpsRevisionConflict',
  {
    code: Schema.Literal('siampark_ops_revision_conflict'),
    reason: Schema.String,
  },
) {}
