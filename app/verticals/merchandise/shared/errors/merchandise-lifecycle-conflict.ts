import { Schema } from 'effect';

export class MerchandiseLifecycleConflict extends Schema.TaggedError<MerchandiseLifecycleConflict>()(
  'MerchandiseLifecycleConflict',
  {
    code: Schema.Literal('merchandise_lifecycle_conflict'),
    reason: Schema.String,
  },
) {}
