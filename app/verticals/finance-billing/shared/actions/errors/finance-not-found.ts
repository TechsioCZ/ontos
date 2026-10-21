import { Schema } from 'effect';

export class FinanceNotFound extends Schema.TaggedError<FinanceNotFound>()('FinanceNotFound', {
  code: Schema.Literal('finance_not_found'),
  reason: Schema.String,
}) {}
