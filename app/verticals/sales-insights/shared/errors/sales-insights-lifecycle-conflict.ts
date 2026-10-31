import { Schema } from 'effect';

export class SalesInsightsLifecycleConflict extends Schema.TaggedError<SalesInsightsLifecycleConflict>()(
  'SalesInsightsLifecycleConflict',
  {
    code: Schema.Literal('sales_insights_lifecycle_conflict'),
    reason: Schema.String,
  },
) {}
