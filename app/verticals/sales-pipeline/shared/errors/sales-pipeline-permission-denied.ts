import { Schema } from 'effect';

export class SalesPipelinePermissionDenied extends Schema.TaggedError<SalesPipelinePermissionDenied>()(
  'SalesPipelinePermissionDenied',
  {
    code: Schema.Literal('sales_pipeline_permission_denied'),
    reason: Schema.String,
  },
) {}
