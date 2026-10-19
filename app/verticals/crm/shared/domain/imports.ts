// AREA: imports (C03, C04) — owned by the crm-imports lane.
// CSV import batches, imported external orders (projection, never edited), state history, row errors, dedup,
// approved external-customer links and the manual pairing history.
// Adding fields: make them Schema.optionalKey (persisted JSON from older revisions must still decode).
import { Schema } from 'effect';
import type { CrmViewer } from './access.ts';
import { canSeeEverything } from './access.ts';
import { EntityIdSchema, IsoTimeSchema, LongTextSchema, PrincipalIdSchema, ShortTextSchema } from './common.ts';

/** Exact decimal as a string ("1234.50"); never a float. Always paired with a currency. */
export const DecimalStringSchema = Schema.String.check(Schema.isPattern(/^-?\d{1,15}(\.\d{1,4})?$/u));

export const ImportRowErrorSchema = Schema.Struct({
  message: LongTextSchema,
  row: Schema.Int,
});

export const ImportBatchSchema = Schema.Struct({
  accepted: Schema.Int,
  duplicates: Schema.Int,
  errors: Schema.Array(ImportRowErrorSchema),
  fileName: ShortTextSchema,
  /** Template / format version, e.g. "crm-orders-csv-v1". */
  format: ShortTextSchema,
  id: EntityIdSchema,
  importedAt: IsoTimeSchema,
  importedBy: PrincipalIdSchema,
  rejected: Schema.Int,
  rowCount: Schema.Int,
  /** Source system, e.g. "E-shop" or "Účetní systém". */
  source: ShortTextSchema,
  status: Schema.Literals(['completed', 'completed_with_errors', 'failed']),
});
export type ImportBatch = typeof ImportBatchSchema.Type;

export const OrderStatusEventSchema = Schema.Struct({
  batchId: EntityIdSchema,
  eventAt: Schema.optionalKey(IsoTimeSchema),
  eventId: Schema.optionalKey(ShortTextSchema),
  importedAt: IsoTimeSchema,
  rawStatus: ShortTextSchema,
  /** Order of events unknown / older than the confirmed one: kept, flagged, not applied (C03). */
  review: Schema.optionalKey(Schema.Boolean),
});

export const OrderLineSchema = Schema.Struct({
  amount: Schema.optionalKey(DecimalStringSchema),
  externalId: Schema.optionalKey(ShortTextSchema),
  name: ShortTextSchema,
  quantity: DecimalStringSchema,
  sku: Schema.optionalKey(ShortTextSchema),
});

export const PairingStateSchema = Schema.Literals(['paired', 'unpaired', 'review']);

export const ImportedOrderSchema = Schema.Struct({
  amount: Schema.optionalKey(DecimalStringSchema),
  /** Paired client; absent while unpaired / in review. */
  clientId: Schema.optionalKey(EntityIdSchema),
  currency: Schema.optionalKey(ShortTextSchema),
  customerName: Schema.optionalKey(ShortTextSchema),
  /** Another order this one duplicates across sources (kept out of confirmed totals). */
  duplicateOf: Schema.optionalKey(EntityIdSchema),
  externalCustomerId: Schema.optionalKey(ShortTextSchema),
  externalId: ShortTextSchema,
  id: EntityIdSchema,
  lastEventAt: Schema.optionalKey(IsoTimeSchema),
  /** Present only when the source really sends lines (never invented). */
  lines: Schema.optionalKey(Schema.Array(OrderLineSchema)),
  number: Schema.optionalKey(ShortTextSchema),
  orderedAt: Schema.optionalKey(IsoTimeSchema),
  pairing: PairingStateSchema,
  rawStatus: ShortTextSchema,
  receivedAt: IsoTimeSchema,
  source: ShortTextSchema,
  statusHistory: Schema.Array(OrderStatusEventSchema),
});
export type ImportedOrder = typeof ImportedOrderSchema.Type;

/** Approved correlation external customer id -> client (C04-01). */
export const CustomerLinkSchema = Schema.Struct({
  clientId: EntityIdSchema,
  createdAt: IsoTimeSchema,
  createdBy: PrincipalIdSchema,
  externalCustomerId: ShortTextSchema,
  source: ShortTextSchema,
});
export type CustomerLink = typeof CustomerLinkSchema.Type;

export const PairingChangeSchema = Schema.Struct({
  at: IsoTimeSchema,
  by: PrincipalIdSchema,
  fromClientId: Schema.optionalKey(EntityIdSchema),
  id: EntityIdSchema,
  orderId: EntityIdSchema,
  reason: LongTextSchema,
  toClientId: Schema.optionalKey(EntityIdSchema),
  via: Schema.Literals(['manual', 'customer_link']),
});
export type PairingChange = typeof PairingChangeSchema.Type;

export const ImportsSliceSchema = Schema.Struct({
  batches: Schema.Array(ImportBatchSchema),
  customerLinks: Schema.Array(CustomerLinkSchema),
  orders: Schema.Array(ImportedOrderSchema),
  pairingHistory: Schema.Array(PairingChangeSchema),
});
export type ImportsSlice = typeof ImportsSliceSchema.Type;

export const initialImportsSlice: ImportsSlice = { batches: [], customerLinks: [], orders: [], pairingHistory: [] };

/**
 * Read projection. read_all sees everything (batches, unpaired queue). A salesperson sees only orders paired to
 * visible clients and their pairing history; never batches or the unpaired queue.
 */
export const projectImportsSlice = (
  slice: ImportsSlice,
  visible: ReadonlySet<string>,
  viewer: CrmViewer,
): ImportsSlice => {
  if (canSeeEverything(viewer)) {
    return slice;
  }
  const orders = slice.orders.filter((order) => order.clientId !== undefined && visible.has(order.clientId));
  const orderIds = new Set(orders.map((order) => order.id));
  return {
    batches: [],
    customerLinks: slice.customerLinks.filter((link) => visible.has(link.clientId)),
    orders,
    pairingHistory: slice.pairingHistory.filter((change) => orderIds.has(change.orderId)),
  };
};
