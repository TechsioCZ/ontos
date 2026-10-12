import { Schema } from 'effect';

export class SalesPipelineNotFound extends Schema.TaggedError<SalesPipelineNotFound>()('SalesPipelineNotFound', {
  code: Schema.Literal('sales_pipeline_not_found'),
  reason: Schema.String,
}) {}
