import { Schema } from 'effect';

export class SalesPipelineRevisionConflict extends Schema.TaggedError<SalesPipelineRevisionConflict>()(
  'SalesPipelineRevisionConflict',
  {
    code: Schema.Literal('sales_pipeline_revision_conflict'),
    reason: Schema.String,
  },
) {}
