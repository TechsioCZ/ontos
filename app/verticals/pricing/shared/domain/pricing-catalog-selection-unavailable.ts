import { Schema } from 'effect';

export class PricingCatalogSelectionUnavailable extends Schema.TaggedError<PricingCatalogSelectionUnavailable>()(
  'PricingCatalogSelectionUnavailable',
  {
    code: Schema.Literal('pricing_catalog_selection_unavailable'),
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}
