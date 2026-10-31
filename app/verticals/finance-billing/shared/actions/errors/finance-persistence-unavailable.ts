import { Schema } from 'effect';

export class FinancePersistenceUnavailable extends Schema.TaggedError<FinancePersistenceUnavailable>()(
  'FinancePersistenceUnavailable',
  {
    code: Schema.Literal('finance_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
