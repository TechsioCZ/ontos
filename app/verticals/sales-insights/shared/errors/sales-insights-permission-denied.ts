import { Schema } from 'effect';

export class SalesInsightsPermissionDenied extends Schema.TaggedError<SalesInsightsPermissionDenied>()(
  'SalesInsightsPermissionDenied',
  {
    code: Schema.Literal('sales_insights_permission_denied'),
    reason: Schema.String,
  },
) {}
