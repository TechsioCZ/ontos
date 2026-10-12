import { Schema } from 'effect';

export class SalesInsightsScopeMismatch extends Schema.TaggedError<SalesInsightsScopeMismatch>()(
  'SalesInsightsScopeMismatch',
  {
    code: Schema.Literal('sales_insights_scope_mismatch'),
    reason: Schema.String,
  },
) {}
