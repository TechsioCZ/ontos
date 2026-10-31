import { Schema } from 'effect';

export class SalesInsightsNotFound extends Schema.TaggedError<SalesInsightsNotFound>()('SalesInsightsNotFound', {
  code: Schema.Literal('sales_insights_not_found'),
  reason: Schema.String,
}) {}
