import { Schema } from 'effect';
import { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';

import { StockItemIdSchema, StockItemRefSchema } from '../resources/stock-item.ts';

const BoundedIdentifierSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));

export const ExactCatalogSelectionMeaningIdSchema = BoundedIdentifierSchema.pipe(
  Schema.brand('ExactCatalogSelectionMeaningId'),
);
export type ExactCatalogSelectionMeaningId = typeof ExactCatalogSelectionMeaningIdSchema.Type;

export const ExactCatalogSelectionKindSchema = Schema.Literals([
  'PRODUCT_VARIANT',
  'PACKAGE_OPTION',
  'SET_VARIANT',
  'CONFIGURED_SELECTION',
]);
export type ExactCatalogSelectionKind = typeof ExactCatalogSelectionKindSchema.Type;

/**
 * An opaque Catalog-owned meaning identity. Inventory retains it exactly and
 * deliberately cannot derive it from Product, SKU, labels, package contents,
 * Set components, or configuration attributes.
 */
export const ExactCatalogSelectionMeaningSchema = Schema.Struct({
  id: ExactCatalogSelectionMeaningIdSchema,
  kind: ExactCatalogSelectionKindSchema,
});
export type ExactCatalogSelectionMeaning = typeof ExactCatalogSelectionMeaningSchema.Type;

export const StockItemLifecycleSchema = Schema.Literals(['CURRENT', 'RETIRED']);

export const StockItemInstantSchema = Schema.toEncoded(Schema.DateTimeUtcFromString);
export type StockItemInstant = typeof StockItemInstantSchema.Type;

export const StockItemRevisionSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 }),
);

export const CreateStockItemInputSchema = Schema.Struct({
  exactSelectionMeaning: ExactCatalogSelectionMeaningSchema,
  tenantId: StockItemRefSchema.fields.tenantId,
  unitRef: ProductUnitRefSchema,
}).check(
  Schema.makeFilter(({ tenantId, unitRef }) =>
    tenantId === unitRef.tenantId ? undefined : 'Stock Item and exact Catalog Unit must share one Tenant',
  ),
);
export type CreateStockItemInput = typeof CreateStockItemInputSchema.Type;

export const StockItemCompatibilityInputSchema = Schema.Struct({
  exactSelectionMeaning: ExactCatalogSelectionMeaningSchema,
  unitRef: ProductUnitRefSchema,
});
export type StockItemCompatibilityInput = typeof StockItemCompatibilityInputSchema.Type;

export const StockItemSchema = Schema.Struct({
  createdAt: StockItemInstantSchema,
  exactSelectionMeaning: ExactCatalogSelectionMeaningSchema,
  lifecycle: StockItemLifecycleSchema,
  retiredAt: Schema.toEncoded(Schema.OptionFromNullOr(StockItemInstantSchema)),
  revision: StockItemRevisionSchema,
  stockItemRef: StockItemRefSchema,
  unitRef: ProductUnitRefSchema,
}).check(
  Schema.makeFilter((item) => {
    if (item.stockItemRef.tenantId !== item.unitRef.tenantId) {
      return 'Stock Item and exact Catalog Unit must share one Tenant';
    }
    return (item.lifecycle === 'CURRENT' && item.retiredAt === null) ||
      (item.lifecycle === 'RETIRED' && item.retiredAt !== null)
      ? undefined
      : 'Stock Item retirement timestamp must match its lifecycle';
  }),
);
export type StockItem = typeof StockItemSchema.Type;

export class StockItemRejected extends Schema.TaggedError<StockItemRejected>()('StockItemRejected', {
  code: Schema.Literal('stock_item_rejected'),
  exactSelectionMeaningId: Schema.optionalKey(ExactCatalogSelectionMeaningIdSchema),
  reason: Schema.Literals([
    'exact_selection_meaning_already_registered',
    'exact_selection_meaning_mismatch',
    'stock_item_not_found',
    'stock_item_retired',
    'stock_unit_mismatch',
  ]),
  stockItemId: Schema.optionalKey(StockItemIdSchema),
}) {}
