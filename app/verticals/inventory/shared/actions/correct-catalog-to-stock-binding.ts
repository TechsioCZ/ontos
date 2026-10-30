import { Schema } from 'effect';

import { CatalogToStockBindingUnavailable } from '../domain/catalog-to-stock-binding-unavailable.ts';
import {
  CatalogToStockBindingCorrectionInputSchema,
  CatalogToStockBindingRejected,
  CatalogToStockBindingRevisionSchema,
} from '../domain/catalog-to-stock-binding.ts';
import { StockItemSchema } from '../domain/stock-item.ts';
import { CatalogToStockBindingRefSchema } from '../resources/catalog-to-stock-binding.ts';

export { CatalogToStockBindingSchema as CorrectCatalogToStockBindingResultSchema } from '../domain/catalog-to-stock-binding.ts';

/** Exact Correction intent; the owner derives the new Item's identity and foundation. */
export const StockItemReplacementCorrectionCandidateSchema = Schema.TaggedStruct('REPLACE_CURRENT_STOCK_ITEM', {
  catalogSelection: CatalogToStockBindingCorrectionInputSchema.fields.candidate.fields.catalogSelection,
  exactSelectionMeaning: CatalogToStockBindingCorrectionInputSchema.fields.candidate.fields.exactSelectionMeaning,
  expectedBindingRevision: CatalogToStockBindingRevisionSchema,
  expectedStockItemRef: StockItemSchema.fields.stockItemRef,
  expectedStockItemRevision: StockItemSchema.fields.revision,
}).check(
  Schema.makeFilter(({ catalogSelection, expectedStockItemRef }) =>
    catalogSelection.productRef.tenantId === expectedStockItemRef.tenantId
      ? undefined
      : 'Replacement source Item and exact Catalog Selection must share one Tenant',
  ),
);
export type StockItemReplacementCorrectionCandidate = typeof StockItemReplacementCorrectionCandidateSchema.Type;

export const CorrectCatalogToStockBindingPayloadSchema = Schema.Struct({
  bindingRef: CatalogToStockBindingRefSchema,
  candidate: Schema.Union([
    CatalogToStockBindingCorrectionInputSchema.fields.candidate,
    StockItemReplacementCorrectionCandidateSchema,
  ]),
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
