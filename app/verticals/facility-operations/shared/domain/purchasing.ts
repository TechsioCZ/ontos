// Facility operations — agenda `purchasing` (S05 sklad a zásoby + S06 poptávky, nákupní objednávky, příjem dodávek).
// OWNED BY THE `purchasing` LANE (ops-purchasing).
// One JSONB document per (tenant, legal entity): warehouses, suppliers, stock items, an append-only movement ledger,
// planned issues, supplier quotes and purchase orders. Stock on hand is ALWAYS computed from the movement ledger.
import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';
import {
  AuditFieldsSchema,
  IsoDateSchema,
  MinorAmountSchema,
  NoteSchema,
  PropertyRefSchema,
  TextSchema,
  OpsIdSchema,
} from './common.ts';

export const StockWarehouseIdSchema = OpsIdSchema.pipe(Schema.brand('FacilityStockWarehouseId'));
export type StockWarehouseId = typeof StockWarehouseIdSchema.Type;
export const StockItemIdSchema = OpsIdSchema.pipe(Schema.brand('FacilityStockItemId'));
export type StockItemId = typeof StockItemIdSchema.Type;
export const StockMovementIdSchema = OpsIdSchema.pipe(Schema.brand('FacilityStockMovementId'));
export type StockMovementId = typeof StockMovementIdSchema.Type;
export const StockPlannedIssueIdSchema = OpsIdSchema.pipe(Schema.brand('FacilityStockPlannedIssueId'));
export type StockPlannedIssueId = typeof StockPlannedIssueIdSchema.Type;
export const SupplierIdSchema = OpsIdSchema.pipe(Schema.brand('FacilitySupplierId'));
export type SupplierId = typeof SupplierIdSchema.Type;
export const SupplierQuoteIdSchema = OpsIdSchema.pipe(Schema.brand('FacilitySupplierQuoteId'));
export type SupplierQuoteId = typeof SupplierQuoteIdSchema.Type;
export const PurchaseOrderIdSchema = OpsIdSchema.pipe(Schema.brand('FacilityPurchaseOrderId'));
export type PurchaseOrderId = typeof PurchaseOrderIdSchema.Type;
export const PurchaseLineIdSchema = OpsIdSchema.pipe(Schema.brand('FacilityPurchaseLineId'));
export type PurchaseLineId = typeof PurchaseLineIdSchema.Type;

/** Whole units (ks, l, kg, bal …). Positive. */
export const QuantitySchema = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000));
/** Non-negative whole units (min/max levels, delivered quantity). */
export const LevelSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_000_000));
export const LeadTimeDaysSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(365));
export const SerialNumberSchema = TextSchema(100);
export const BatchSchema = TextSchema(100);
export const CurrencySchema = Schema.Literals(['CZK', 'EUR']);
export type Currency = typeof CurrencySchema.Type;

export const StockItemCategorySchema = Schema.Literals(['consumable', 'spare_part', 'cleaning', 'chemical', 'tool']);
export type StockItemCategory = typeof StockItemCategorySchema.Type;
/** `batch` = šarže (receipt needs a batch code), `serial` = every unit has its own serial number. */
export const StockTrackingSchema = Schema.Literals(['none', 'batch', 'serial']);
export type StockTracking = typeof StockTrackingSchema.Type;

export const StockWarehouseSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  code: TextSchema(32),
  id: StockWarehouseIdSchema,
  location: Schema.optionalKey(PropertyRefSchema),
  name: TextSchema(200),
});
export type StockWarehouse = typeof StockWarehouseSchema.Type;

export const SupplierIcoSchema = Schema.String.check(Schema.isPattern(/^\d{8}$/u)).pipe(
  Schema.brand('FacilitySupplierIco'),
  Schema.decodeTo(Schema.String),
);

export const SupplierSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  contact: Schema.optionalKey(TextSchema(200)),
  email: Schema.optionalKey(TextSchema(200)),
  ico: Schema.optionalKey(SupplierIcoSchema),
  id: SupplierIdSchema,
  leadTimeDays: Schema.optionalKey(LeadTimeDaysSchema),
  name: TextSchema(200),
  note: Schema.optionalKey(NoteSchema),
  phone: Schema.optionalKey(TextSchema(64)),
});
export type Supplier = typeof SupplierSchema.Type;

export const StockItemSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  category: StockItemCategorySchema,
  id: StockItemIdSchema,
  leadTimeDays: LeadTimeDaysSchema,
  maximum: LevelSchema,
  minimum: LevelSchema,
  name: TextSchema(200),
  sku: TextSchema(64),
  supplierId: Schema.optionalKey(SupplierIdSchema),
  tracking: StockTrackingSchema,
  unit: TextSchema(16),
  warehouseId: StockWarehouseIdSchema,
  /** Last purchase unit price (from a received purchase order line), CZK minor units. */
  lastPriceMinor: Schema.optionalKey(MinorAmountSchema),
  location: Schema.optionalKey(PropertyRefSchema),
  note: Schema.optionalKey(NoteSchema),
});
export type StockItem = typeof StockItemSchema.Type;

/** Traceability link of a movement or planned issue: order, task, unit/property/asset, document. Display snapshot. */
export const StockRefKindSchema = Schema.Literals(['purchase_order', 'task', 'unit', 'property', 'asset', 'document']);
export type StockRefKind = typeof StockRefKindSchema.Type;
export const StockRefSchema = Schema.Struct({
  id: TextSchema(300),
  kind: StockRefKindSchema,
  label: TextSchema(300),
});
export type StockRef = typeof StockRefSchema.Type;

export const StockMovementKindSchema = Schema.Literals(['receipt', 'issue', 'transfer', 'adjustment']);
export type StockMovementKind = typeof StockMovementKindSchema.Type;

/**
 * Ledger row. `quantity` is the signed change in `warehouseId` for receipt (+), issue (−) and adjustment (±).
 * A transfer moves `quantity` (+) from `fromWarehouseId` to `warehouseId` and does not change the total.
 */
export const StockMovementSchema = Schema.Struct({
  batch: Schema.optionalKey(BatchSchema),
  createdAt: Schema.DateTimeUtcFromString,
  createdBy: PrincipalRefSchema,
  date: IsoDateSchema,
  fromWarehouseId: Schema.optionalKey(StockWarehouseIdSchema),
  id: StockMovementIdSchema,
  itemId: StockItemIdSchema,
  kind: StockMovementKindSchema,
  plannedIssueId: Schema.optionalKey(StockPlannedIssueIdSchema),
  purchaseOrderId: Schema.optionalKey(PurchaseOrderIdSchema),
  quantity: Schema.Int,
  reason: TextSchema(500),
  refs: Schema.Array(StockRefSchema),
  serialNumbers: Schema.optionalKey(Schema.Array(SerialNumberSchema)),
  warehouseId: StockWarehouseIdSchema,
});
export type StockMovement = typeof StockMovementSchema.Type;

export const PlannedIssueStatusSchema = Schema.Literals(['planned', 'issued', 'cancelled']);
export type PlannedIssueStatus = typeof PlannedIssueStatusSchema.Type;
export const StockPlannedIssueSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  date: IsoDateSchema,
  id: StockPlannedIssueIdSchema,
  itemId: StockItemIdSchema,
  quantity: QuantitySchema,
  reason: TextSchema(500),
  refs: Schema.Array(StockRefSchema),
  status: PlannedIssueStatusSchema,
});
export type StockPlannedIssue = typeof StockPlannedIssueSchema.Type;

export const QuoteLineSchema = Schema.Struct({
  description: TextSchema(300),
  id: PurchaseLineIdSchema,
  itemId: Schema.optionalKey(StockItemIdSchema),
  quantity: QuantitySchema,
  unitPriceMinor: MinorAmountSchema,
});
export type QuoteLine = typeof QuoteLineSchema.Type;

export const SupplierQuoteStatusSchema = Schema.Literals(['received', 'accepted', 'rejected']);
export type SupplierQuoteStatus = typeof SupplierQuoteStatusSchema.Type;
export const SupplierQuoteSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  currency: CurrencySchema,
  date: IsoDateSchema,
  id: SupplierQuoteIdSchema,
  lines: Schema.Array(QuoteLineSchema),
  note: Schema.optionalKey(NoteSchema),
  number: TextSchema(64),
  purchaseOrderId: Schema.optionalKey(PurchaseOrderIdSchema),
  status: SupplierQuoteStatusSchema,
  supplierId: SupplierIdSchema,
  validUntil: Schema.optionalKey(IsoDateSchema),
});
export type SupplierQuote = typeof SupplierQuoteSchema.Type;

/** S06: návrh → schváleno → objednáno → částečně dodáno → dokončeno; zrušeno. */
export const PurchaseOrderStatusSchema = Schema.Literals([
  'draft',
  'approved',
  'ordered',
  'partially_delivered',
  'completed',
  'cancelled',
]);
export type PurchaseOrderStatus = typeof PurchaseOrderStatusSchema.Type;

export const PurchaseOrderLineSchema = Schema.Struct({
  description: TextSchema(300),
  id: PurchaseLineIdSchema,
  itemId: Schema.optionalKey(StockItemIdSchema),
  quantity: QuantitySchema,
  /** Price kept from the quote (or typed for a direct order); never re-read from the item. */
  quoteLineId: Schema.optionalKey(PurchaseLineIdSchema),
  receivedQuantity: LevelSchema,
  unitPriceMinor: MinorAmountSchema,
});
export type PurchaseOrderLine = typeof PurchaseOrderLineSchema.Type;

export const DeliveryLineSchema = Schema.Struct({
  batch: Schema.optionalKey(BatchSchema),
  lineId: PurchaseLineIdSchema,
  quantity: QuantitySchema,
  serialNumbers: Schema.optionalKey(Schema.Array(SerialNumberSchema)),
});
export type DeliveryLine = typeof DeliveryLineSchema.Type;

export const PurchaseDeliverySchema = Schema.Struct({
  date: IsoDateSchema,
  deliveryNote: Schema.optionalKey(TextSchema(64)),
  id: TextSchema(300),
  lines: Schema.Array(DeliveryLineSchema),
  movementIds: Schema.Array(StockMovementIdSchema),
  receivedAt: Schema.DateTimeUtcFromString,
  receivedBy: PrincipalRefSchema,
});
export type PurchaseDelivery = typeof PurchaseDeliverySchema.Type;

/** Reference to the received (supplier) invoice. Finance owns the invoice itself (finance-billing). */
export const PurchaseInvoiceRefSchema = Schema.Struct({
  amountMinor: Schema.optionalKey(MinorAmountSchema),
  invoiceDate: Schema.optionalKey(IsoDateSchema),
  linkedAt: Schema.DateTimeUtcFromString,
  linkedBy: PrincipalRefSchema,
  note: Schema.optionalKey(NoteSchema),
  number: TextSchema(64),
});
export type PurchaseInvoiceRef = typeof PurchaseInvoiceRefSchema.Type;

const OrderHistoryEventSchema = Schema.Literals([
  'created',
  'approved',
  'ordered',
  'delivery',
  'invoice',
  'cancelled',
  'completed',
]);

export const PurchaseOrderHistorySchema = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  by: PrincipalRefSchema,
  event: OrderHistoryEventSchema,
  note: Schema.optionalKey(NoteSchema),
  status: PurchaseOrderStatusSchema,
});
export type PurchaseOrderHistory = typeof PurchaseOrderHistorySchema.Type;

export const PurchaseOrderSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  currency: CurrencySchema,
  id: PurchaseOrderIdSchema,
  number: TextSchema(64),
  quoteId: Schema.optionalKey(SupplierQuoteIdSchema),
  status: PurchaseOrderStatusSchema,
  supplierId: SupplierIdSchema,
  /** Goods are received into this warehouse; lines without a stock item are services (no movement). */
  deliveries: Schema.Array(PurchaseDeliverySchema),
  expectedDate: Schema.optionalKey(IsoDateSchema),
  history: Schema.Array(PurchaseOrderHistorySchema),
  invoices: Schema.Array(PurchaseInvoiceRefSchema),
  lines: Schema.Array(PurchaseOrderLineSchema),
  note: Schema.optionalKey(NoteSchema),
  warehouseId: StockWarehouseIdSchema,
});
export type PurchaseOrder = typeof PurchaseOrderSchema.Type;

// ── Prodej (S06): customer quotes → sales orders → issued invoice draft in Finance ───────────────────────────────

export const SalesQuoteIdSchema = OpsIdSchema.pipe(Schema.brand('FacilitySalesQuoteId'));
export type SalesQuoteId = typeof SalesQuoteIdSchema.Type;
export const SalesOrderIdSchema = OpsIdSchema.pipe(Schema.brand('FacilitySalesOrderId'));
export type SalesOrderId = typeof SalesOrderIdSchema.Type;

/** Customer = a party-registry counterparty; snapshot of its identity and name taken when the quote was made. */
export const SalesCustomerSchema = Schema.Struct({
  counterpartyId: TextSchema(300),
  name: TextSchema(300),
  partyId: Schema.optionalKey(TextSchema(300)),
  tenantId: TextSchema(300),
});
export type SalesCustomer = typeof SalesCustomerSchema.Type;

export const SalesVatRateSchema = Schema.Literals([0, 10, 12, 21]);
export type SalesVatRate = typeof SalesVatRateSchema.Type;

export const SalesLineSchema = Schema.Struct({
  description: TextSchema(300),
  id: PurchaseLineIdSchema,
  itemId: Schema.optionalKey(StockItemIdSchema),
  quantity: QuantitySchema,
  /** Unit price without VAT, CZK minor units; kept from the quote, never re-read. */
  unitPriceMinor: MinorAmountSchema,
  vatRate: SalesVatRateSchema,
});
export type SalesLine = typeof SalesLineSchema.Type;

export const SalesQuoteStatusSchema = Schema.Literals(['draft', 'sent', 'accepted', 'rejected']);
export type SalesQuoteStatus = typeof SalesQuoteStatusSchema.Type;
export const SalesQuoteSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  currency: CurrencySchema,
  customer: SalesCustomerSchema,
  date: IsoDateSchema,
  id: SalesQuoteIdSchema,
  lines: Schema.Array(SalesLineSchema),
  note: Schema.optionalKey(NoteSchema),
  number: TextSchema(64),
  related: Schema.optionalKey(PropertyRefSchema),
  salesOrderId: Schema.optionalKey(SalesOrderIdSchema),
  status: SalesQuoteStatusSchema,
  validUntil: Schema.optionalKey(IsoDateSchema),
});
export type SalesQuote = typeof SalesQuoteSchema.Type;

export const SalesOrderLineSchema = Schema.Struct({
  ...SalesLineSchema.fields,
  deliveredQuantity: LevelSchema,
  quoteLineId: Schema.optionalKey(PurchaseLineIdSchema),
});
export type SalesOrderLine = typeof SalesOrderLineSchema.Type;

export const SalesDeliverySchema = Schema.Struct({
  date: IsoDateSchema,
  id: TextSchema(300),
  lines: Schema.Array(Schema.Struct({ lineId: PurchaseLineIdSchema, quantity: QuantitySchema })),
  note: Schema.optionalKey(NoteSchema),
  recordedAt: Schema.DateTimeUtcFromString,
  recordedBy: PrincipalRefSchema,
});
export type SalesDelivery = typeof SalesDeliverySchema.Type;

/** Issued invoice (draft) that Finance created from this order; Finance owns the invoice itself. */
export const SalesInvoiceLinkSchema = Schema.Struct({
  invoiceId: TextSchema(300),
  linkedAt: Schema.DateTimeUtcFromString,
  linkedBy: PrincipalRefSchema,
  number: TextSchema(64),
  totalMinor: Schema.optionalKey(MinorAmountSchema),
});
export type SalesInvoiceLink = typeof SalesInvoiceLinkSchema.Type;

export const SalesOrderHistorySchema = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  by: PrincipalRefSchema,
  event: OrderHistoryEventSchema,
  note: Schema.optionalKey(NoteSchema),
  status: PurchaseOrderStatusSchema,
});
export type SalesOrderHistory = typeof SalesOrderHistorySchema.Type;

/** Same lifecycle as purchase orders: návrh → schváleno → objednáno → částečně dodáno → dokončeno; zrušeno. */
export const SalesOrderSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  currency: CurrencySchema,
  customer: SalesCustomerSchema,
  deliveries: Schema.Array(SalesDeliverySchema),
  expectedDate: Schema.optionalKey(IsoDateSchema),
  history: Schema.Array(SalesOrderHistorySchema),
  id: SalesOrderIdSchema,
  invoices: Schema.Array(SalesInvoiceLinkSchema),
  lines: Schema.Array(SalesOrderLineSchema),
  note: Schema.optionalKey(NoteSchema),
  number: TextSchema(64),
  quoteId: Schema.optionalKey(SalesQuoteIdSchema),
  quoteNumber: Schema.optionalKey(TextSchema(64)),
  related: Schema.optionalKey(PropertyRefSchema),
  status: PurchaseOrderStatusSchema,
});
export type SalesOrder = typeof SalesOrderSchema.Type;

/** Base (without VAT) and total with VAT of sales lines; VAT rounded per line to whole haléře. */
export const salesTotals = (lines: readonly Pick<SalesLine, 'quantity' | 'unitPriceMinor' | 'vatRate'>[]) => {
  let baseMinor = 0;
  let totalMinor = 0;
  for (const line of lines) {
    const base = line.quantity * line.unitPriceMinor;
    const vat = Math.floor((base * line.vatRate + 50) / 100);
    baseMinor += base;
    totalMinor += base + vat;
  }
  return { baseMinor, totalMinor };
};

/** `items` first: the overview counts the first array of each agenda state as its record count. */
export const PurchasingStateSchema = Schema.Struct({
  items: Schema.Array(StockItemSchema),
  movements: Schema.Array(StockMovementSchema),
  orders: Schema.Array(PurchaseOrderSchema),
  plannedIssues: Schema.Array(StockPlannedIssueSchema),
  quotes: Schema.Array(SupplierQuoteSchema),
  salesOrders: Schema.optionalKey(Schema.Array(SalesOrderSchema)),
  salesQuotes: Schema.optionalKey(Schema.Array(SalesQuoteSchema)),
  suppliers: Schema.Array(SupplierSchema),
  warehouses: Schema.Array(StockWarehouseSchema),
});
export type PurchasingState = typeof PurchasingStateSchema.Type;
export type PurchasingStateEncoded = typeof PurchasingStateSchema.Encoded;

/** State written by the seed when nothing else is known. Must decode with PurchasingStateSchema. */
export const emptyPurchasingState: PurchasingStateEncoded = {
  items: [],
  movements: [],
  orders: [],
  plannedIssues: [],
  quotes: [],
  suppliers: [],
  warehouses: [],
};
