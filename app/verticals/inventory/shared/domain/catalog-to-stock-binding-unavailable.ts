import { Schema } from 'effect';

export class CatalogToStockBindingUnavailable extends Schema.TaggedError<CatalogToStockBindingUnavailable>()(
  'CatalogToStockBindingUnavailable',
  {
    code: Schema.Literal('catalog_to_stock_binding_unavailable'),
    reason: Schema.String,
  },
) {}
