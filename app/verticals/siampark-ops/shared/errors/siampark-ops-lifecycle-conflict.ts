import { Schema } from 'effect';

export class SiamparkOpsLifecycleConflict extends Schema.TaggedError<SiamparkOpsLifecycleConflict>()(
  'SiamparkOpsLifecycleConflict',
  {
    code: Schema.Literal('siampark_ops_lifecycle_conflict'),
    reason: Schema.String,
  },
) {}
