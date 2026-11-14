import { Schema } from 'effect';

export class FinanceConflict extends Schema.TaggedError<FinanceConflict>()('FinanceConflict', {
  code: Schema.Literal('finance_conflict'),
  reason: Schema.String,
}) {}
