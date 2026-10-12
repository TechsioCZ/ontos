import { Schema } from 'effect';

export class SalesPipelineReferenceUnavailable extends Schema.TaggedError<SalesPipelineReferenceUnavailable>()(
  'SalesPipelineReferenceUnavailable',
  {
    code: Schema.Literal('sales_pipeline_reference_unavailable'),
    reason: Schema.String,
  },
) {}
