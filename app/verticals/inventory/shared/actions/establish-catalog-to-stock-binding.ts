import { Schema } from 'effect';

import { CatalogToStockBindingUnavailable } from '../domain/catalog-to-stock-binding-unavailable.ts';
import {
  CatalogToStockBindingCandidateSchema,
  CatalogToStockBindingLifecycleEvidenceSchema,
  CatalogToStockBindingRejected,
} from '../domain/catalog-to-stock-binding.ts';
import { CatalogToStockBindingRefSchema } from '../resources/catalog-to-stock-binding.ts';

export { CatalogToStockBindingSchema as EstablishCatalogToStockBindingResultSchema } from '../domain/catalog-to-stock-binding.ts';

export const EstablishCatalogToStockBindingPayloadSchema = Schema.Struct({
  bindingRef: CatalogToStockBindingRefSchema,
  candidate: CatalogToStockBindingCandidateSchema,
  evidence: CatalogToStockBindingLifecycleEvidenceSchema,
}).check(
  Schema.makeFilter(({ bindingRef, candidate }) =>
    bindingRef.tenantId === candidate.catalogSelection.productRef.tenantId
      ? undefined
      : 'Proposed binding and exact Catalog Selection must share one Tenant',
  ),
);
export type EstablishCatalogToStockBindingPayload = typeof EstablishCatalogToStockBindingPayloadSchema.Type;

export const EstablishCatalogToStockBindingErrorSchema = Schema.Union([
  CatalogToStockBindingRejected,
  CatalogToStockBindingUnavailable,
]);
