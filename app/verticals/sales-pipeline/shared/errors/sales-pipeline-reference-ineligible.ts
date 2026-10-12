import { Schema } from 'effect';

export class SalesPipelineReferenceIneligible extends Schema.TaggedError<SalesPipelineReferenceIneligible>()(
  'SalesPipelineReferenceIneligible',
  {
    code: Schema.Literal('sales_pipeline_reference_ineligible'),
    reason: Schema.String,
  },
) {}
