import { Schema } from 'effect';

export class SalesPipelineScopeMismatch extends Schema.TaggedError<SalesPipelineScopeMismatch>()(
  'SalesPipelineScopeMismatch',
  {
    code: Schema.Literal('sales_pipeline_scope_mismatch'),
    reason: Schema.String,
  },
) {}
