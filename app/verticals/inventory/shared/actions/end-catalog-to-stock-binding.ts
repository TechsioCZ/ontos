import { Schema } from 'effect';

import { CatalogToStockBindingUnavailable } from '../domain/catalog-to-stock-binding-unavailable.ts';
import {
  CatalogToStockBindingEndInputSchema,
  CatalogToStockBindingRejected,
} from '../domain/catalog-to-stock-binding.ts';

export { CatalogToStockBindingEndResultSchema as EndCatalogToStockBindingResultSchema } from '../domain/catalog-to-stock-binding.ts';

export const EndCatalogToStockBindingPayloadSchema = CatalogToStockBindingEndInputSchema;
export type EndCatalogToStockBindingPayload = typeof EndCatalogToStockBindingPayloadSchema.Type;

export const EndCatalogToStockBindingErrorSchema = Schema.Union([
  CatalogToStockBindingRejected,
  CatalogToStockBindingUnavailable,
]);
