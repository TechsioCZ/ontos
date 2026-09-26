import { Schema } from 'effect';

import { CatalogToStockBindingUnavailable } from '../domain/catalog-to-stock-binding-unavailable.ts';
import {
  CatalogToStockBindingCorrectionInputSchema,
  CatalogToStockBindingRejected,
} from '../domain/catalog-to-stock-binding.ts';
import { CatalogToStockBindingRefSchema } from '../resources/catalog-to-stock-binding.ts';

export { CatalogToStockBindingSchema as CorrectCatalogToStockBindingResultSchema } from '../domain/catalog-to-stock-binding.ts';

export const CorrectCatalogToStockBindingPayloadSchema = Schema.Struct({
  bindingRef: CatalogToStockBindingRefSchema,
  candidate: CatalogToStockBindingCorrectionInputSchema.fields.candidate,
  evidence: CatalogToStockBindingCorrectionInputSchema.fields.evidence,
}).check(
  Schema.makeFilter(({ bindingRef, candidate }) =>
    bindingRef.tenantId === candidate.catalogSelection.productRef.tenantId
      ? undefined
      : 'Binding and exact Catalog Selection must share one Tenant',
  ),
);
export type CorrectCatalogToStockBindingPayload = typeof CorrectCatalogToStockBindingPayloadSchema.Type;

export const CorrectCatalogToStockBindingErrorSchema = Schema.Union([
  CatalogToStockBindingRejected,
  CatalogToStockBindingUnavailable,
]);
