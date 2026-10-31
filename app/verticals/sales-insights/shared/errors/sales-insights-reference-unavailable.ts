import { Schema } from 'effect';

export class SalesInsightsReferenceUnavailable extends Schema.TaggedError<SalesInsightsReferenceUnavailable>()(
  'SalesInsightsReferenceUnavailable',
  {
    code: Schema.Literal('sales_insights_reference_unavailable'),
    reason: Schema.String,
  },
) {}
