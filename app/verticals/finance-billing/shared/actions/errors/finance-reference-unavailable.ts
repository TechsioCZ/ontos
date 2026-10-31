import { Schema } from 'effect';

export class FinanceReferenceUnavailable extends Schema.TaggedError<FinanceReferenceUnavailable>()(
  'FinanceReferenceUnavailable',
  {
    code: Schema.Literal('finance_reference_unavailable'),
    reason: Schema.String,
  },
) {}
