// Merchandise domain model (demo stand-in for catalog, pricing and inventory).
// Money is integer CZK minor units. Order lines snapshot name, sku, price and VAT at creation and never
// re-read the current product afterwards (brief requirement 7d).
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';

const idOf = (brand: string) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(Schema.brand(brand));

export const ProductIdSchema = idOf('ProductId');
export type ProductId = typeof ProductIdSchema.Type;
export const StockMovementIdSchema = idOf('StockMovementId');
export type StockMovementId = typeof StockMovementIdSchema.Type;
export const OrderIdSchema = idOf('OrderId');
export type OrderId = typeof OrderIdSchema.Type;
/** Opaque reference to a party owned by party-registry. Never joined here. */
export const PartyIdSchema = idOf('PartyId');
export type PartyId = typeof PartyIdSchema.Type;
/** Opaque reference to a sales-pipeline opportunity. Never joined here. */
export const OpportunityIdSchema = idOf('OpportunityId');
export type OpportunityId = typeof OpportunityIdSchema.Type;

export const ProductUnitSchema = Schema.Literals(['ks', 'bal', 'hod', 'lic']);
export type ProductUnit = typeof ProductUnitSchema.Type;
export const VatRateSchema = Schema.Literals([0, 10, 12, 21]);
export type VatRate = typeof VatRateSchema.Type;
export const StockMovementReasonSchema = Schema.Literals(['RECEIPT', 'ISSUE', 'ADJUSTMENT', 'ORDER']);
export type StockMovementReason = typeof StockMovementReasonSchema.Type;
export const OrderStatusSchema = Schema.Literals(['NEW', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED']);
export type OrderStatus = typeof OrderStatusSchema.Type;

/** Non-negative integer amount in CZK minor units (haléře). */
export const EntityIdSchema = idOf('MerchandiseEntityId');
export type EntityId = typeof EntityIdSchema.Type;

export const MinorAmountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const TextSchema = (maximum: number) => Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

export const PriceHistoryEntrySchema = Schema.Struct({
  changedBy: Schema.optionalKey(PrincipalRefSchema),
  effectiveFrom: Schema.DateTimeUtcFromString,
  priceMinor: MinorAmountSchema,
});
export type PriceHistoryEntry = typeof PriceHistoryEntrySchema.Type;

/** Informational variants never carry SKU, price or inventory identity. */
export const ProductVariantSchema = Schema.Struct({
  attributes: Schema.Trim.check(Schema.isMaxLength(1000)),
  name: TextSchema(100),
});

/** Optional keys preserve old JSONB snapshots; null and empty values explicitly clear metadata. */
const MeasurementSchema = Schema.OptionFromNullOr(
  Schema.Int.check(Schema.isBetween({ maximum: 1_000_000_000, minimum: 1 })),
);
export const ProductMetadataSchema = Schema.Struct({
  description: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(20_000))),
  heightMm: Schema.optionalKey(MeasurementSchema),
  lengthMm: Schema.optionalKey(MeasurementSchema),
  shortDescription: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(500))),
  variants: Schema.optionalKey(Schema.Array(ProductVariantSchema).check(Schema.isMaxLength(50))),
  weightGrams: Schema.optionalKey(MeasurementSchema),
  widthMm: Schema.optionalKey(MeasurementSchema),
});
export type ProductMetadata = typeof ProductMetadataSchema.Type;

export const ProductSchema = Schema.Struct({
  ...ProductMetadataSchema.fields,
  active: Schema.Boolean,
  category: TextSchema(120),
  createdAt: Schema.DateTimeUtcFromString,
  currentPriceMinor: MinorAmountSchema,
  id: ProductIdSchema,
  lowStockThreshold: MinorAmountSchema,
  name: TextSchema(200),
  priceHistory: Schema.Array(PriceHistoryEntrySchema),
  sku: TextSchema(64),
  unit: ProductUnitSchema,
  updatedAt: Schema.DateTimeUtcFromString,
  vatRate: VatRateSchema,
});
export type Product = typeof ProductSchema.Type;

/** SKUs match case-insensitively and ignore surrounding spaces, so "ms-ergo" and "MS-ERGO" are one product. */
export const sameSku = (left: string, right: string): boolean =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

/** Product plus values derived from the stock ledger and current price at read time. */
export const ProductRecordSchema = Schema.Struct({
  ...ProductSchema.fields,
  lowStock: Schema.Boolean,
  stockOnHand: Schema.Int,
  stockValueMinor: Schema.Int,
});
export type ProductRecord = typeof ProductRecordSchema.Type;

/** Signed quantity: positive for receipts, negative for issues. */
export const StockMovementSchema = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  delta: Schema.Int,
  id: StockMovementIdSchema,
  note: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(2000))),
  productId: ProductIdSchema,
  reason: StockMovementReasonSchema,
  reference: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(200))),
});
export type StockMovement = typeof StockMovementSchema.Type;

export const OrderLineSchema = Schema.Struct({
  productId: ProductIdSchema,
  productName: TextSchema(200),
  quantity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  sku: TextSchema(64),
  unitPriceMinor: MinorAmountSchema,
  vatRate: VatRateSchema,
});
export type OrderLine = typeof OrderLineSchema.Type;

export const OrderSchema = Schema.Struct({
  createdAt: Schema.DateTimeUtcFromString,
  id: OrderIdSchema,
  lines: Schema.Array(OrderLineSchema).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  number: TextSchema(40),
  opportunityId: Schema.optionalKey(OpportunityIdSchema),
  partyId: PartyIdSchema,
  status: OrderStatusSchema,
  totalMinor: MinorAmountSchema,
  totalVatMinor: MinorAmountSchema,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type Order = typeof OrderSchema.Type;
