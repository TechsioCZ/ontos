import { Schema } from 'effect';

export class SalesPipelinePersistenceUnavailable extends Schema.TaggedError<SalesPipelinePersistenceUnavailable>()(
  'SalesPipelinePersistenceUnavailable',
  {
    code: Schema.Literal('sales_pipeline_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
