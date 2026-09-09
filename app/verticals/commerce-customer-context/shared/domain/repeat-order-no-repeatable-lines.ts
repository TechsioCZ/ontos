import { Schema } from 'effect';

export class RepeatOrderNoRepeatableLines extends Schema.TaggedError<RepeatOrderNoRepeatableLines>()(
  'RepeatOrderNoRepeatableLines',
  {
    code: Schema.Literal('repeat_order_no_repeatable_lines'),
    reason: Schema.String,
  },
) {}
