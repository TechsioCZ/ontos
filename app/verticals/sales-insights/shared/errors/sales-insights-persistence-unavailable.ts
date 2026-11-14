import { Schema } from 'effect';

export class SalesInsightsPersistenceUnavailable extends Schema.TaggedError<SalesInsightsPersistenceUnavailable>()(
  'SalesInsightsPersistenceUnavailable',
  {
    code: Schema.Literal('sales_insights_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
