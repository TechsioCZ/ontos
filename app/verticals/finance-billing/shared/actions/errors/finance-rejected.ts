import { Schema } from 'effect';

export class FinanceRejected extends Schema.TaggedError<FinanceRejected>()('FinanceRejected', {
  code: Schema.Literal('finance_rejected'),
  reason: Schema.String,
}) {}
