import { Schema } from 'effect';

/** Typed stub failure for commands whose behavior lands in the next task. Remove once implemented. */
export class SalesPipelineNotImplemented extends Schema.TaggedError<SalesPipelineNotImplemented>()(
  'SalesPipelineNotImplemented',
  {
    code: Schema.Literal('sales_pipeline_not_implemented'),
    reason: Schema.String,
  },
) {}
