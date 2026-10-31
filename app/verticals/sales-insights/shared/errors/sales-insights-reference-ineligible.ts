import { Schema } from 'effect';

export class SalesInsightsReferenceIneligible extends Schema.TaggedError<SalesInsightsReferenceIneligible>()(
  'SalesInsightsReferenceIneligible',
  {
    code: Schema.Literal('sales_insights_reference_ineligible'),
    reason: Schema.String,
  },
) {}
