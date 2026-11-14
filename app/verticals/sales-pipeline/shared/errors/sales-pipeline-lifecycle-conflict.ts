import { Schema } from 'effect';

export class SalesPipelineLifecycleConflict extends Schema.TaggedError<SalesPipelineLifecycleConflict>()(
  'SalesPipelineLifecycleConflict',
  {
    code: Schema.Literal('sales_pipeline_lifecycle_conflict'),
    reason: Schema.String,
  },
) {}
