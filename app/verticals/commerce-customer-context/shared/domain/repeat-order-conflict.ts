import { Schema } from 'effect';

export class RepeatOrderConflict extends Schema.TaggedError<RepeatOrderConflict>()(
  'RepeatOrderConflict',
  {
    code: Schema.Literal('repeat_order_conflict'),
    reason: Schema.String,
  },
) {}
