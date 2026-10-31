import { Schema } from 'effect';

export class SalesInsightsRevisionConflict extends Schema.TaggedError<SalesInsightsRevisionConflict>()(
  'SalesInsightsRevisionConflict',
  {
    code: Schema.Literal('sales_insights_revision_conflict'),
    reason: Schema.String,
  },
) {}
