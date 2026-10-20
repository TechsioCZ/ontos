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

export const ProductUnitSchema = Schema.Literals(['ks', 'bal', 'hod', 'lic', 'm', 'tab', 'set', '0', '1']);
export type ProductUnit = typeof ProductUnitSchema.Type;
export const VatRateSchema = Schema.Literals([0, 10, 12, 21]);
export type VatRate = typeof VatRateSchema.Type;
export const StockMovementReasonSchema = Schema.Literals(['RECEIPT', 'ISSUE', 'ADJUSTMENT', 'ORDER']);
export type StockMovementReason = typeof StockMovementReasonSchema.Type;
/**
 * Order workflow. PACKING („Připravená k předání“), CONFIRMED („Zpracovává se“) was added for the e-shop demo; SHIPPED is the
 * simulated hand-over to a carrier („Předáno dopravci (simulace)“), DELIVERED is „Dokončená“.
 */
export const OrderStatusSchema = Schema.Literals(['NEW', 'CONFIRMED', 'PACKING', 'SHIPPED', 'DELIVERED', 'CANCELLED']);
export type OrderStatus = typeof OrderStatusSchema.Type;

/** Non-negative integer amount in CZK minor units (haléře). */
export const EntityIdSchema = idOf('MerchandiseEntityId');
export type EntityId = typeof EntityIdSchema.Type;

export const MinorAmountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const TextSchema = (maximum: number) => Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

export const PriceHistoryEntrySchema = Schema.Struct({
  /** Snapshot before the edit; optional for legacy and initial-price entries. */
  previousPriceMinor: Schema.optionalKey(MinorAmountSchema),
  changedBy: Schema.optionalKey(PrincipalRefSchema),
  effectiveFrom: Schema.DateTimeUtcFromString,
  priceMinor: MinorAmountSchema,
});
export type PriceHistoryEntry = typeof PriceHistoryEntrySchema.Type;

export const VariantIdSchema = idOf('VariantId');
export type VariantId = typeof VariantIdSchema.Type;

/**
 * Product variant. Legacy informational variants carry only name/attributes. A „real“ variant has its own
 * identity (`id`), SKU, net price (`priceMinor`), stock (ledger movements with `variantId`) and `active` flag.
 * `name` is the customer-facing label, e.g. „250 g / zrnková“.
 */
/** Source catalog gross tiers; legacy priceMinor remains net. */
export const CatalogParameterSchema = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  unit: Schema.String,
});
export const PriceTierSchema = Schema.Struct({
  minimumQuantity: Schema.Finite,
  priceMinor: MinorAmountSchema,
  priceExcludingVatMinor: MinorAmountSchema,
});
export const CatalogFieldsSchema = Schema.Struct({
  minimumQuantity: Schema.optionalKey(Schema.Finite),
  packageQuantity: Schema.optionalKey(Schema.Finite),
  priceTiers: Schema.optionalKey(Schema.Array(PriceTierSchema)),
  parameters: Schema.optionalKey(Schema.Array(CatalogParameterSchema)),
  sourceId: Schema.optionalKey(Schema.String),
  sourceUnit: Schema.optionalKey(Schema.String),
  imageSrc: Schema.optionalKey(Schema.String),
});
export const ProductVariantSchema = Schema.Struct({
  ...CatalogFieldsSchema.fields,
  unit: Schema.optionalKey(Schema.String),
  active: Schema.optionalKey(Schema.Boolean),
  attributes: Schema.Trim.check(Schema.isMaxLength(1000)),
  id: Schema.optionalKey(VariantIdSchema),
  name: TextSchema(100),
  priceHistory: Schema.optionalKey(Schema.Array(PriceHistoryEntrySchema)),
  priceMinor: Schema.optionalKey(MinorAmountSchema),
  sku: Schema.optionalKey(TextSchema(64)),
});
export type ProductVariant = typeof ProductVariantSchema.Type;

/** A variant with an identity and a price is a real sellable variant. */
export const isRealVariant = (
  variant: ProductVariant,
): variant is ProductVariant & { readonly id: VariantId; readonly priceMinor: number } =>
  variant.id !== undefined && variant.priceMinor !== undefined;

export const AvailabilitySchema = Schema.Literals(['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'UNKNOWN']);
export type Availability = typeof AvailabilitySchema.Type;

/** Image reference: relative storefront path (`/img/<slug>.svg`) or absolute http(s) URL. */
export const ImageRefSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500));

/** Optional keys preserve old JSONB snapshots; null and empty values explicitly clear metadata. */
const MeasurementSchema = Schema.OptionFromNullOr(
  Schema.Int.check(Schema.isBetween({ maximum: 1_000_000_000, minimum: 1 })),
);
export const ProductMetadataSchema = Schema.Struct({
  ...CatalogFieldsSchema.fields,
  sourceProductId: Schema.optionalKey(Schema.String),
  sourceGroupId: Schema.optionalKey(Schema.String),
  categoryId: Schema.optionalKey(Schema.String),
  categoryPathIds: Schema.optionalKey(Schema.Array(Schema.String)),
  featuredPosition: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  isAction: Schema.optionalKey(Schema.Boolean),
  isRecommended: Schema.optionalKey(Schema.Boolean),
  isSale: Schema.optionalKey(Schema.Boolean),
  isNew: Schema.optionalKey(Schema.Boolean),
  description: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(20_000))),
  heightMm: Schema.optionalKey(MeasurementSchema),
  lengthMm: Schema.optionalKey(MeasurementSchema),
  images: Schema.optionalKey(Schema.Array(ImageRefSchema).check(Schema.isMaxLength(20))),
  /** Storefront visibility; absent means published when active. */
  published: Schema.optionalKey(Schema.Boolean),
  shortDescription: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(500))),
  slug: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  /** `false` means stock is not tracked here, so availability is reported as UNKNOWN („nelze ověřit“). */
  stockTracked: Schema.optionalKey(Schema.Boolean),
  variants: Schema.optionalKey(Schema.Array(ProductVariantSchema).check(Schema.isMaxLength(1000))),
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

/** Unit price including VAT, rounded half-up per unit. The storefront shows this; it never computes VAT. */
export const grossUnitPriceMinor = (netMinor: number, vatRate: number): number =>
  netMinor + Math.floor((netMinor * vatRate + 50) / 100);

/** Variant plus derived stock, availability and gross price. */
export const VariantRecordSchema = Schema.Struct({
  ...CatalogFieldsSchema.fields,
  unit: Schema.optionalKey(Schema.String),
  active: Schema.Boolean,
  attributes: Schema.String,
  availability: AvailabilitySchema,
  grossPriceMinor: MinorAmountSchema,
  id: VariantIdSchema,
  name: Schema.String,
  priceHistory: Schema.Array(PriceHistoryEntrySchema),
  priceMinor: MinorAmountSchema,
  sku: Schema.String,
  stockOnHand: Schema.Finite,
});
export type VariantRecord = typeof VariantRecordSchema.Type;

/** Product plus values derived from the stock ledger and current price at read time. */
export const ProductRecordSchema = Schema.Struct({
  ...ProductSchema.fields,
  availability: Schema.optionalKey(AvailabilitySchema),
  grossPriceMinor: Schema.optionalKey(MinorAmountSchema),
  lowStock: Schema.Boolean,
  stockOnHand: Schema.Finite,
  stockValueMinor: Schema.Int,
  variantRecords: Schema.optionalKey(Schema.Array(VariantRecordSchema)),
});
export type ProductRecord = typeof ProductRecordSchema.Type;

/** Signed quantity: positive for receipts, negative for issues. */
export const StockMovementSchema = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  delta: Schema.Finite,
  id: StockMovementIdSchema,
  note: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(2000))),
  productId: ProductIdSchema,
  reason: StockMovementReasonSchema,
  reference: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(200))),
  variantId: Schema.optionalKey(VariantIdSchema),
});
export type StockMovement = typeof StockMovementSchema.Type;

export const OrderLineSchema = Schema.Struct({
  productId: ProductIdSchema,
  productName: TextSchema(200),
  quantity: Schema.Finite.check(Schema.isGreaterThan(0)),
  sku: TextSchema(64),
  unitPriceMinor: MinorAmountSchema,
  variantId: Schema.optionalKey(VariantIdSchema),
  variantName: Schema.optionalKey(Schema.String),
  vatRate: VatRateSchema,
});
export type OrderLine = typeof OrderLineSchema.Type;

export const ShippingMethodSchema = Schema.Literals(['ZASILKOVNA', 'PPL', 'CESKA_POSTA', 'OSOBNI_ODBER']);
export type ShippingMethod = typeof ShippingMethodSchema.Type;

/** Simulated carriers. Prices are gross (incl. 21 % VAT). Nothing is ever sent to a real carrier. */
export const shippingMethods: Readonly<
  Record<ShippingMethod, { readonly grossPriceMinor: number; readonly label: string }>
> = {
  CESKA_POSTA: { grossPriceMinor: 11_900, label: 'Česká pošta – Balík Do ruky (simulace)' },
  OSOBNI_ODBER: { grossPriceMinor: 0, label: 'Osobní odběr – Kavárna Doma, Brno (simulace)' },
  PPL: { grossPriceMinor: 12_900, label: 'PPL – doručení na adresu (simulace)' },
  ZASILKOVNA: { grossPriceMinor: 7_900, label: 'Zásilkovna – výdejní místo (simulace)' },
};

/** Keep pickup identity consistent across storefront placement, staff editing and audit snapshots. */
export const shippingMethodFor = (method: ShippingMethod, akros = false) =>
  method === 'OSOBNI_ODBER' && akros
    ? { ...shippingMethods[method], label: 'Osobní odběr – AKROS (simulace)' }
    : shippingMethods[method];

export const OrderShippingSchema = Schema.Struct({
  label: Schema.String,
  method: ShippingMethodSchema,
  /** Gross shipping price (incl. VAT). */
  priceMinor: MinorAmountSchema,
  vatRate: VatRateSchema,
});
export type OrderShipping = typeof OrderShippingSchema.Type;

export const OrderContactSchema = Schema.Struct({
  email: Schema.Trim.check(
    Schema.isMinLength(3),
    Schema.isMaxLength(200),
    Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u),
  ),
  name: TextSchema(200),
  phone: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(40))),
});
export type OrderContact = typeof OrderContactSchema.Type;

export const OrderAddressSchema = Schema.Struct({
  city: TextSchema(120),
  country: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(80))),
  postalCode: Schema.Trim.check(Schema.isMinLength(3), Schema.isMaxLength(12)),
  street: TextSchema(200),
});
export type OrderAddress = typeof OrderAddressSchema.Type;

export const OrderHistoryKindSchema = Schema.Literals([
  'CREATED',
  'STATUS',
  'LINES',
  'SHIPPING',
  'ADDRESS',
  'CONTACT',
  'NOTE',
]);
export type OrderHistoryKind = typeof OrderHistoryKindSchema.Type;

/** One audited change of an order; `before`/`after` are human-readable Czech summaries. */
export const OrderHistoryEntrySchema = Schema.Struct({
  actor: Schema.optionalKey(PrincipalRefSchema),
  actorLabel: Schema.optionalKey(Schema.String),
  after: Schema.optionalKey(Schema.String),
  at: Schema.DateTimeUtcFromString,
  before: Schema.optionalKey(Schema.String),
  kind: OrderHistoryKindSchema,
  reason: Schema.optionalKey(Schema.String),
});
export type OrderHistoryEntry = typeof OrderHistoryEntrySchema.Type;

export const OrderChannelSchema = Schema.Literals(['STAFF', 'STOREFRONT']);
export type OrderChannel = typeof OrderChannelSchema.Type;

export const OrderSchema = Schema.Struct({
  channel: Schema.optionalKey(OrderChannelSchema),
  /** Caller-supplied storefront submission id; one id maps to exactly one order. */
  clientRequestId: Schema.optionalKey(Schema.String),
  contact: Schema.optionalKey(OrderContactSchema),
  createdAt: Schema.DateTimeUtcFromString,
  /** DEMO marker: a presentation order, never paid, reserved or shipped. */
  demo: Schema.optionalKey(Schema.Boolean),
  /** Soft removal preserves the receipt, audit history and clientRequestId replay identity. */
  demoCleanup: Schema.optionalKey(
    Schema.Struct({
      at: Schema.DateTimeUtcFromString,
      actor: PrincipalRefSchema,
      reason: TextSchema(500),
    }),
  ),
  deliveryAddress: Schema.optionalKey(OrderAddressSchema),
  history: Schema.optionalKey(Schema.Array(OrderHistoryEntrySchema)),
  id: OrderIdSchema,
  lines: Schema.Array(OrderLineSchema).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  note: Schema.optionalKey(Schema.String),
  number: TextSchema(40),
  opportunityId: Schema.optionalKey(OpportunityIdSchema),
  partyId: PartyIdSchema,
  /** When true, line `unitPriceMinor` is gross (incl. VAT) and totals are summed from gross lines. */
  pricesIncludeVat: Schema.optionalKey(Schema.Boolean),
  shipping: Schema.optionalKey(OrderShippingSchema),
  status: OrderStatusSchema,
  totalMinor: MinorAmountSchema,
  totalVatMinor: MinorAmountSchema,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type Order = typeof OrderSchema.Type;
