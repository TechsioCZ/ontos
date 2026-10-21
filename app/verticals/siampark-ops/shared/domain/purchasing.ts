// Siampark provoz — agenda `purchasing` (S05 sklad a zásoby + S06 poptávky, nákupní objednávky, příjem dodávek).
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
  opsIdOf,
} from './common.ts';

export const StockWarehouseIdSchema = opsIdOf('SiamparkStockWarehouseId');
export type StockWarehouseId = typeof StockWarehouseIdSchema.Type;
export const StockItemIdSchema = opsIdOf('SiamparkStockItemId');
export type StockItemId = typeof StockItemIdSchema.Type;
export const StockMovementIdSchema = opsIdOf('SiamparkStockMovementId');
export type StockMovementId = typeof StockMovementIdSchema.Type;
export const StockPlannedIssueIdSchema = opsIdOf('SiamparkStockPlannedIssueId');
export type StockPlannedIssueId = typeof StockPlannedIssueIdSchema.Type;
export const SupplierIdSchema = opsIdOf('SiamparkSupplierId');
export type SupplierId = typeof SupplierIdSchema.Type;
export const SupplierQuoteIdSchema = opsIdOf('SiamparkSupplierQuoteId');
export type SupplierQuoteId = typeof SupplierQuoteIdSchema.Type;
export const PurchaseOrderIdSchema = opsIdOf('SiamparkPurchaseOrderId');
export type PurchaseOrderId = typeof PurchaseOrderIdSchema.Type;
export const PurchaseLineIdSchema = opsIdOf('SiamparkPurchaseLineId');
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
  id: StockWarehouseIdSchema,
  code: TextSchema(32),
  name: TextSchema(200),
  location: Schema.optionalKey(PropertyRefSchema),
});
export type StockWarehouse = typeof StockWarehouseSchema.Type;

export const SupplierSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  id: SupplierIdSchema,
  name: TextSchema(200),
  ico: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d{8}$/))),
  contact: Schema.optionalKey(TextSchema(200)),
  email: Schema.optionalKey(TextSchema(200)),
  phone: Schema.optionalKey(TextSchema(64)),
  leadTimeDays: Schema.optionalKey(LeadTimeDaysSchema),
  note: Schema.optionalKey(NoteSchema),
});
export type Supplier = typeof SupplierSchema.Type;

export const StockItemSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  id: StockItemIdSchema,
  sku: TextSchema(64),
  name: TextSchema(200),
  category: StockItemCategorySchema,
  warehouseId: StockWarehouseIdSchema,
  unit: TextSchema(16),
  tracking: StockTrackingSchema,
  minimum: LevelSchema,
  maximum: LevelSchema,
  leadTimeDays: LeadTimeDaysSchema,
  supplierId: Schema.optionalKey(SupplierIdSchema),
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
  kind: StockRefKindSchema,
  id: TextSchema(300),
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
  id: StockMovementIdSchema,
  itemId: StockItemIdSchema,
  kind: StockMovementKindSchema,
  quantity: Schema.Int,
  warehouseId: StockWarehouseIdSchema,
  fromWarehouseId: Schema.optionalKey(StockWarehouseIdSchema),
  date: IsoDateSchema,
  reason: TextSchema(500),
  batch: Schema.optionalKey(BatchSchema),
  serialNumbers: Schema.optionalKey(Schema.Array(SerialNumberSchema)),
  refs: Schema.Array(StockRefSchema),
  purchaseOrderId: Schema.optionalKey(PurchaseOrderIdSchema),
  plannedIssueId: Schema.optionalKey(StockPlannedIssueIdSchema),
  createdAt: Schema.DateTimeUtcFromString,
  createdBy: PrincipalRefSchema,
});
export type StockMovement = typeof StockMovementSchema.Type;

export const PlannedIssueStatusSchema = Schema.Literals(['planned', 'issued', 'cancelled']);
export type PlannedIssueStatus = typeof PlannedIssueStatusSchema.Type;
export const StockPlannedIssueSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  id: StockPlannedIssueIdSchema,
  itemId: StockItemIdSchema,
  quantity: QuantitySchema,
  date: IsoDateSchema,
  reason: TextSchema(500),
  refs: Schema.Array(StockRefSchema),
  status: PlannedIssueStatusSchema,
});
export type StockPlannedIssue = typeof StockPlannedIssueSchema.Type;

export const QuoteLineSchema = Schema.Struct({
  id: PurchaseLineIdSchema,
  itemId: Schema.optionalKey(StockItemIdSchema),
  description: TextSchema(300),
  quantity: QuantitySchema,
  unitPriceMinor: MinorAmountSchema,
});
export type QuoteLine = typeof QuoteLineSchema.Type;

export const SupplierQuoteStatusSchema = Schema.Literals(['received', 'accepted', 'rejected']);
export type SupplierQuoteStatus = typeof SupplierQuoteStatusSchema.Type;
export const SupplierQuoteSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  id: SupplierQuoteIdSchema,
  number: TextSchema(64),
  supplierId: SupplierIdSchema,
  date: IsoDateSchema,
  validUntil: Schema.optionalKey(IsoDateSchema),
  currency: CurrencySchema,
  lines: Schema.Array(QuoteLineSchema),
  status: SupplierQuoteStatusSchema,
  purchaseOrderId: Schema.optionalKey(PurchaseOrderIdSchema),
  note: Schema.optionalKey(NoteSchema),
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
  id: PurchaseLineIdSchema,
  itemId: Schema.optionalKey(StockItemIdSchema),
  description: TextSchema(300),
  quantity: QuantitySchema,
  /** Price kept from the quote (or typed for a direct order); never re-read from the item. */
  unitPriceMinor: MinorAmountSchema,
  receivedQuantity: LevelSchema,
  quoteLineId: Schema.optionalKey(PurchaseLineIdSchema),
});
export type PurchaseOrderLine = typeof PurchaseOrderLineSchema.Type;

export const DeliveryLineSchema = Schema.Struct({
  lineId: PurchaseLineIdSchema,
  quantity: QuantitySchema,
  batch: Schema.optionalKey(BatchSchema),
  serialNumbers: Schema.optionalKey(Schema.Array(SerialNumberSchema)),
});
export type DeliveryLine = typeof DeliveryLineSchema.Type;

export const PurchaseDeliverySchema = Schema.Struct({
  id: TextSchema(300),
  date: IsoDateSchema,
  deliveryNote: Schema.optionalKey(TextSchema(64)),
  lines: Schema.Array(DeliveryLineSchema),
  movementIds: Schema.Array(StockMovementIdSchema),
  receivedAt: Schema.DateTimeUtcFromString,
  receivedBy: PrincipalRefSchema,
});
export type PurchaseDelivery = typeof PurchaseDeliverySchema.Type;

/** Reference to the received (supplier) invoice. Finance owns the invoice itself (siampark-billing-finance). */
export const PurchaseInvoiceRefSchema = Schema.Struct({
  number: TextSchema(64),
  invoiceDate: Schema.optionalKey(IsoDateSchema),
  amountMinor: Schema.optionalKey(MinorAmountSchema),
  note: Schema.optionalKey(NoteSchema),
  linkedAt: Schema.DateTimeUtcFromString,
  linkedBy: PrincipalRefSchema,
});
export type PurchaseInvoiceRef = typeof PurchaseInvoiceRefSchema.Type;

export const PurchaseOrderHistorySchema = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  by: PrincipalRefSchema,
  status: PurchaseOrderStatusSchema,
  event: Schema.Literals(['created', 'approved', 'ordered', 'delivery', 'invoice', 'cancelled', 'completed']),
  note: Schema.optionalKey(NoteSchema),
});
export type PurchaseOrderHistory = typeof PurchaseOrderHistorySchema.Type;

export const PurchaseOrderSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  id: PurchaseOrderIdSchema,
  number: TextSchema(64),
  supplierId: SupplierIdSchema,
  quoteId: Schema.optionalKey(SupplierQuoteIdSchema),
  status: PurchaseOrderStatusSchema,
  currency: CurrencySchema,
  /** Goods are received into this warehouse; lines without a stock item are services (no movement). */
  warehouseId: StockWarehouseIdSchema,
  expectedDate: Schema.optionalKey(IsoDateSchema),
  lines: Schema.Array(PurchaseOrderLineSchema),
  deliveries: Schema.Array(PurchaseDeliverySchema),
  invoices: Schema.Array(PurchaseInvoiceRefSchema),
  history: Schema.Array(PurchaseOrderHistorySchema),
  note: Schema.optionalKey(NoteSchema),
});
export type PurchaseOrder = typeof PurchaseOrderSchema.Type;

// ── Prodej (S06): customer quotes → sales orders → issued invoice draft in Finance ───────────────────────────────

export const SalesQuoteIdSchema = opsIdOf('SiamparkSalesQuoteId');
export type SalesQuoteId = typeof SalesQuoteIdSchema.Type;
export const SalesOrderIdSchema = opsIdOf('SiamparkSalesOrderId');
export type SalesOrderId = typeof SalesOrderIdSchema.Type;

/** Customer = a party-registry counterparty; snapshot of its identity and name taken when the quote was made. */
export const SalesCustomerSchema = Schema.Struct({
  counterpartyId: TextSchema(300),
  partyId: Schema.optionalKey(TextSchema(300)),
  tenantId: TextSchema(300),
  name: TextSchema(300),
});
export type SalesCustomer = typeof SalesCustomerSchema.Type;

export const SalesVatRateSchema = Schema.Literals([0, 10, 12, 21]);
export type SalesVatRate = typeof SalesVatRateSchema.Type;

export const SalesLineSchema = Schema.Struct({
  id: PurchaseLineIdSchema,
  itemId: Schema.optionalKey(StockItemIdSchema),
  description: TextSchema(300),
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
  id: SalesQuoteIdSchema,
  number: TextSchema(64),
  customer: SalesCustomerSchema,
  date: IsoDateSchema,
  validUntil: Schema.optionalKey(IsoDateSchema),
  currency: CurrencySchema,
  lines: Schema.Array(SalesLineSchema),
  status: SalesQuoteStatusSchema,
  salesOrderId: Schema.optionalKey(SalesOrderIdSchema),
  related: Schema.optionalKey(PropertyRefSchema),
  note: Schema.optionalKey(NoteSchema),
});
export type SalesQuote = typeof SalesQuoteSchema.Type;

export const SalesOrderLineSchema = Schema.Struct({
  ...SalesLineSchema.fields,
  deliveredQuantity: LevelSchema,
  quoteLineId: Schema.optionalKey(PurchaseLineIdSchema),
});
export type SalesOrderLine = typeof SalesOrderLineSchema.Type;

export const SalesDeliverySchema = Schema.Struct({
  id: TextSchema(300),
  date: IsoDateSchema,
  lines: Schema.Array(Schema.Struct({ lineId: PurchaseLineIdSchema, quantity: QuantitySchema })),
  note: Schema.optionalKey(NoteSchema),
  recordedAt: Schema.DateTimeUtcFromString,
  recordedBy: PrincipalRefSchema,
});
export type SalesDelivery = typeof SalesDeliverySchema.Type;

/** Issued invoice (draft) that Finance created from this order; Finance owns the invoice itself. */
export const SalesInvoiceLinkSchema = Schema.Struct({
  invoiceId: TextSchema(300),
  number: TextSchema(64),
  totalMinor: Schema.optionalKey(MinorAmountSchema),
  linkedAt: Schema.DateTimeUtcFromString,
  linkedBy: PrincipalRefSchema,
});
export type SalesInvoiceLink = typeof SalesInvoiceLinkSchema.Type;

export const SalesOrderHistorySchema = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  by: PrincipalRefSchema,
  status: PurchaseOrderStatusSchema,
  event: Schema.Literals(['created', 'approved', 'ordered', 'delivery', 'invoice', 'cancelled', 'completed']),
  note: Schema.optionalKey(NoteSchema),
});
export type SalesOrderHistory = typeof SalesOrderHistorySchema.Type;

/** Same lifecycle as purchase orders: návrh → schváleno → objednáno → částečně dodáno → dokončeno; zrušeno. */
export const SalesOrderSchema = Schema.Struct({
  ...AuditFieldsSchema.fields,
  id: SalesOrderIdSchema,
  number: TextSchema(64),
  customer: SalesCustomerSchema,
  quoteId: Schema.optionalKey(SalesQuoteIdSchema),
  quoteNumber: Schema.optionalKey(TextSchema(64)),
  status: PurchaseOrderStatusSchema,
  currency: CurrencySchema,
  expectedDate: Schema.optionalKey(IsoDateSchema),
  lines: Schema.Array(SalesOrderLineSchema),
  deliveries: Schema.Array(SalesDeliverySchema),
  invoices: Schema.Array(SalesInvoiceLinkSchema),
  history: Schema.Array(SalesOrderHistorySchema),
  related: Schema.optionalKey(PropertyRefSchema),
  note: Schema.optionalKey(NoteSchema),
});
export type SalesOrder = typeof SalesOrderSchema.Type;

/** Base (without VAT) and total with VAT of sales lines; VAT rounded per line to whole haléře. */
export const salesTotals = (lines: readonly Pick<SalesLine, 'quantity' | 'unitPriceMinor' | 'vatRate'>[]) =>
  lines.reduce(
    (sum, line) => {
      const base = line.quantity * line.unitPriceMinor;
      const vat = Math.floor((base * line.vatRate + 50) / 100);
      return { baseMinor: sum.baseMinor + base, totalMinor: sum.totalMinor + base + vat };
    },
    { baseMinor: 0, totalMinor: 0 },
  );

/** `items` first: the overview counts the first array of each agenda state as its record count. */
export const PurchasingStateSchema = Schema.Struct({
  items: Schema.Array(StockItemSchema),
  warehouses: Schema.Array(StockWarehouseSchema),
  suppliers: Schema.Array(SupplierSchema),
  movements: Schema.Array(StockMovementSchema),
  plannedIssues: Schema.Array(StockPlannedIssueSchema),
  quotes: Schema.Array(SupplierQuoteSchema),
  orders: Schema.Array(PurchaseOrderSchema),
  salesQuotes: Schema.optionalKey(Schema.Array(SalesQuoteSchema)),
  salesOrders: Schema.optionalKey(Schema.Array(SalesOrderSchema)),
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
