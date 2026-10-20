// Siampark provoz — commands of agenda `purchasing` (S05 sklad a zásoby + S06 poptávky a nákupní objednávky).
// OWNED BY THE `purchasing` LANE (ops-purchasing). Tags are prefixed Stock* / Purchase*.
// The central dispatcher (shared/agendas.ts) picks the agenda by tag; nothing else needs editing.
import { DateTime, Effect, Match, Schema } from 'effect';
import {
  IsoDateSchema,
  MinorAmountSchema,
  NoteSchema,
  PropertyRefSchema,
  TextSchema,
  auditCreated,
  auditUpdated,
  defineAgenda,
  entityIdOf,
  mintId,
  opsConflict,
  opsNotFound,
} from '../domain/common.ts';
import type { EntityId, OpsCommandInput } from '../domain/common.ts';
import {
  BatchSchema,
  CurrencySchema,
  LeadTimeDaysSchema,
  LevelSchema,
  PurchaseLineIdSchema,
  PurchaseOrderIdSchema,
  PurchasingStateSchema,
  QuantitySchema,
  SerialNumberSchema,
  StockItemCategorySchema,
  StockItemIdSchema,
  StockMovementIdSchema,
  StockPlannedIssueIdSchema,
  StockRefSchema,
  StockTrackingSchema,
  StockWarehouseIdSchema,
  SupplierIdSchema,
  SupplierQuoteIdSchema,
  emptyPurchasingState,
} from '../domain/purchasing.ts';
import type {
  PurchaseDelivery,
  PurchaseOrder,
  PurchaseOrderHistory,
  PurchaseOrderLine,
  PurchasingState,
  StockItem,
  StockMovement,
  StockRef,
  StockWarehouseId,
} from '../domain/purchasing.ts';
import { batchQuantityIn, onHandIn, serialsInStock } from '../domain/purchasing-stock.ts';

const RefsSchema = Schema.optionalKey(Schema.Array(StockRefSchema).check(Schema.isMaxLength(10)));
const SerialsSchema = Schema.optionalKey(Schema.Array(SerialNumberSchema).check(Schema.isMaxLength(500)));
const NewLineSchema = Schema.Struct({
  itemId: Schema.optionalKey(StockItemIdSchema),
  description: TextSchema(300),
  quantity: QuantitySchema,
  unitPriceMinor: MinorAmountSchema,
});
const NewLinesSchema = Schema.Array(NewLineSchema).check(Schema.isMinLength(1), Schema.isMaxLength(100));

export const purchasingCommandSchemas = [
  Schema.TaggedStruct('StockWarehouseCreate', {
    code: TextSchema(32),
    name: TextSchema(200),
    location: Schema.optionalKey(PropertyRefSchema),
  }),
  Schema.TaggedStruct('PurchaseSupplierCreate', {
    name: TextSchema(200),
    ico: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d{8}$/))),
    contact: Schema.optionalKey(TextSchema(200)),
    email: Schema.optionalKey(TextSchema(200)),
    phone: Schema.optionalKey(TextSchema(64)),
    leadTimeDays: Schema.optionalKey(LeadTimeDaysSchema),
    note: Schema.optionalKey(NoteSchema),
  }),
  Schema.TaggedStruct('StockItemCreate', {
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
    /** Usual purchase unit price (CZK minor units); a received order line overwrites it. */
    lastPriceMinor: Schema.optionalKey(MinorAmountSchema),
    location: Schema.optionalKey(PropertyRefSchema),
    note: Schema.optionalKey(NoteSchema),
  }),
  Schema.TaggedStruct('StockItemUpdate', {
    itemId: StockItemIdSchema,
    name: Schema.optionalKey(TextSchema(200)),
    category: Schema.optionalKey(StockItemCategorySchema),
    warehouseId: Schema.optionalKey(StockWarehouseIdSchema),
    minimum: Schema.optionalKey(LevelSchema),
    maximum: Schema.optionalKey(LevelSchema),
    leadTimeDays: Schema.optionalKey(LeadTimeDaysSchema),
    supplierId: Schema.optionalKey(SupplierIdSchema),
    lastPriceMinor: Schema.optionalKey(MinorAmountSchema),
    note: Schema.optionalKey(NoteSchema),
  }),
  Schema.TaggedStruct('StockReceipt', {
    itemId: StockItemIdSchema,
    warehouseId: Schema.optionalKey(StockWarehouseIdSchema),
    quantity: QuantitySchema,
    date: IsoDateSchema,
    reason: TextSchema(500),
    batch: Schema.optionalKey(BatchSchema),
    serialNumbers: SerialsSchema,
    refs: RefsSchema,
  }),
  Schema.TaggedStruct('StockIssue', {
    itemId: StockItemIdSchema,
    warehouseId: Schema.optionalKey(StockWarehouseIdSchema),
    quantity: QuantitySchema,
    date: IsoDateSchema,
    reason: TextSchema(500),
    batch: Schema.optionalKey(BatchSchema),
    serialNumbers: SerialsSchema,
    refs: RefsSchema,
    plannedIssueId: Schema.optionalKey(StockPlannedIssueIdSchema),
  }),
  Schema.TaggedStruct('StockTransfer', {
    itemId: StockItemIdSchema,
    fromWarehouseId: StockWarehouseIdSchema,
    toWarehouseId: StockWarehouseIdSchema,
    quantity: QuantitySchema,
    date: IsoDateSchema,
    reason: TextSchema(500),
    batch: Schema.optionalKey(BatchSchema),
    serialNumbers: SerialsSchema,
  }),
  Schema.TaggedStruct('StockAdjustment', {
    itemId: StockItemIdSchema,
    warehouseId: Schema.optionalKey(StockWarehouseIdSchema),
    delta: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1_000_000), Schema.isLessThanOrEqualTo(1_000_000)),
    date: IsoDateSchema,
    /** S05: a correction always needs a reason. */
    reason: TextSchema(500),
    batch: Schema.optionalKey(BatchSchema),
    serialNumbers: SerialsSchema,
  }),
  Schema.TaggedStruct('StockPlannedIssueCreate', {
    itemId: StockItemIdSchema,
    quantity: QuantitySchema,
    date: IsoDateSchema,
    reason: TextSchema(500),
    refs: RefsSchema,
  }),
  Schema.TaggedStruct('StockPlannedIssueCancel', {
    plannedIssueId: StockPlannedIssueIdSchema,
  }),
  Schema.TaggedStruct('PurchaseQuoteCreate', {
    supplierId: SupplierIdSchema,
    number: TextSchema(64),
    date: IsoDateSchema,
    validUntil: Schema.optionalKey(IsoDateSchema),
    currency: CurrencySchema,
    lines: NewLinesSchema,
    note: Schema.optionalKey(NoteSchema),
  }),
  Schema.TaggedStruct('PurchaseQuoteReject', {
    quoteId: SupplierQuoteIdSchema,
    note: Schema.optionalKey(NoteSchema),
  }),
  Schema.TaggedStruct('PurchaseOrderCreate', {
    supplierId: SupplierIdSchema,
    warehouseId: StockWarehouseIdSchema,
    currency: CurrencySchema,
    expectedDate: Schema.optionalKey(IsoDateSchema),
    lines: NewLinesSchema,
    note: Schema.optionalKey(NoteSchema),
  }),
  Schema.TaggedStruct('PurchaseOrderCreateFromQuote', {
    quoteId: SupplierQuoteIdSchema,
    warehouseId: StockWarehouseIdSchema,
    expectedDate: Schema.optionalKey(IsoDateSchema),
    note: Schema.optionalKey(NoteSchema),
  }),
  Schema.TaggedStruct('PurchaseOrderTransition', {
    orderId: PurchaseOrderIdSchema,
    /** approve (návrh→schváleno), order (schváleno→objednáno), cancel, close (částečně dodáno→dokončeno). */
    to: Schema.Literals(['approved', 'ordered', 'cancelled', 'completed']),
    note: Schema.optionalKey(NoteSchema),
  }),
  Schema.TaggedStruct('PurchaseOrderReceive', {
    orderId: PurchaseOrderIdSchema,
    date: IsoDateSchema,
    deliveryNote: Schema.optionalKey(TextSchema(64)),
    lines: Schema.Array(
      Schema.Struct({
        lineId: PurchaseLineIdSchema,
        quantity: QuantitySchema,
        batch: Schema.optionalKey(BatchSchema),
        serialNumbers: SerialsSchema,
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  }),
  Schema.TaggedStruct('PurchaseOrderLinkInvoice', {
    orderId: PurchaseOrderIdSchema,
    number: TextSchema(64),
    invoiceDate: Schema.optionalKey(IsoDateSchema),
    amountMinor: Schema.optionalKey(MinorAmountSchema),
    note: Schema.optionalKey(NoteSchema),
  }),
] as const;

export const PurchasingCommandSchema = Schema.Union(purchasingCommandSchemas);
export type PurchasingCommand = typeof PurchasingCommandSchema.Type;
type CommandOf<Tag extends PurchasingCommand['_tag']> = Extract<PurchasingCommand, { readonly _tag: Tag }>;

const same = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();
const change = (entityIds: readonly EntityId[], state: PurchasingState) => ({ entityIds, state });

const findItem = (state: PurchasingState, itemId: string) =>
  Effect.fromNullishOr(state.items.find((entry) => entry.id === itemId)).pipe(
    Effect.mapError(() => opsNotFound('Stock item not found')),
  );
const findOrder = (state: PurchasingState, orderId: string) =>
  Effect.fromNullishOr(state.orders.find((entry) => entry.id === orderId)).pipe(
    Effect.mapError(() => opsNotFound('Purchase order not found')),
  );
const requireWarehouse = (state: PurchasingState, warehouseId: string) =>
  state.warehouses.some((entry) => entry.id === warehouseId)
    ? Effect.void
    : Effect.fail(opsNotFound('Warehouse not found'));
const requireSupplier = (state: PurchasingState, supplierId: string) =>
  state.suppliers.some((entry) => entry.id === supplierId)
    ? Effect.void
    : Effect.fail(opsNotFound('Supplier not found'));
const requireItems = (state: PurchasingState, itemIds: readonly (string | undefined)[]) =>
  itemIds.every((itemId) => itemId === undefined || state.items.some((entry) => entry.id === itemId))
    ? Effect.void
    : Effect.fail(opsNotFound('Stock item not found'));

const today = (input: OpsCommandInput) => DateTime.formatIsoDate(input.now);

/**
 * Validates the serial/batch evidence of stock entering a warehouse (receipt, positive correction).
 * serial: exactly `quantity` distinct serial numbers, none of them in stock already; batch: a batch code.
 */
const checkIncoming = (
  state: PurchasingState,
  item: StockItem,
  quantity: number,
  batch: string | undefined,
  serialNumbers: readonly string[] | undefined,
) => {
  if (item.tracking === 'serial') {
    const serials = serialNumbers ?? [];
    if (serials.length !== quantity || new Set(serials).size !== serials.length) {
      return Effect.fail(opsConflict('Serial-tracked item needs one unique serial number per unit'));
    }
    const inStock = serialsInStock(state, item.id);
    if (serials.some((serial) => inStock.has(serial))) {
      return Effect.fail(opsConflict('Serial number is already in stock'));
    }
  }
  if (item.tracking === 'batch' && batch === undefined) {
    return Effect.fail(opsConflict('Batch-tracked item needs a batch code'));
  }
  return Effect.void;
};

/** Validates stock leaving a warehouse: never below zero (S05-03), serials/batch must be there. */
const checkOutgoing = (
  state: PurchasingState,
  item: StockItem,
  warehouseId: StockWarehouseId,
  quantity: number,
  batch: string | undefined,
  serialNumbers: readonly string[] | undefined,
) => {
  if (onHandIn(state, item.id, warehouseId) < quantity) {
    return Effect.fail(opsConflict('Insufficient stock in the warehouse'));
  }
  if (item.tracking === 'serial') {
    const serials = serialNumbers ?? [];
    const inStock = serialsInStock(state, item.id);
    if (
      serials.length !== quantity ||
      new Set(serials).size !== serials.length ||
      serials.some((serial) => inStock.get(serial) !== warehouseId)
    ) {
      return Effect.fail(opsConflict('Pick the serial numbers in stock for every unit'));
    }
  }
  if (item.tracking === 'batch' && batch === undefined) {
    return Effect.fail(opsConflict('Batch-tracked item needs a batch code'));
  }
  if (batch !== undefined && batchQuantityIn(state, item.id, batch, warehouseId) < quantity) {
    return Effect.fail(opsConflict('Insufficient quantity of the batch'));
  }
  return Effect.void;
};

const movementOf = (
  input: OpsCommandInput,
  id: StockMovement['id'],
  fields: Omit<StockMovement, 'createdAt' | 'createdBy' | 'id'>,
): StockMovement => ({ ...fields, createdAt: input.now, createdBy: input.actor, id });

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as { readonly [P in K]?: V };

const createWarehouse = Effect.fn('SiamparkOps.Purchasing.warehouseCreate')(function* createWarehouse(
  state: PurchasingState,
  value: CommandOf<'StockWarehouseCreate'>,
  input: OpsCommandInput,
) {
  if (state.warehouses.some((entry) => same(entry.code, value.code))) {
    return yield* opsConflict('A warehouse with this code already exists');
  }
  const id = yield* mintId(StockWarehouseIdSchema, input.resourceId);
  const { _tag: _ignored, ...fields } = value;
  return change([yield* entityIdOf(id)], {
    ...state,
    warehouses: [...state.warehouses, { ...fields, ...auditCreated(input), id }],
  });
});

const createSupplier = Effect.fn('SiamparkOps.Purchasing.supplierCreate')(function* createSupplier(
  state: PurchasingState,
  value: CommandOf<'PurchaseSupplierCreate'>,
  input: OpsCommandInput,
) {
  if (
    state.suppliers.some(
      (entry) => same(entry.name, value.name) || (value.ico !== undefined && entry.ico === value.ico),
    )
  ) {
    return yield* opsConflict('A supplier with this name or IČO already exists');
  }
  const id = yield* mintId(SupplierIdSchema, input.resourceId);
  const { _tag: _ignored, ...fields } = value;
  return change([yield* entityIdOf(id)], {
    ...state,
    suppliers: [...state.suppliers, { ...fields, ...auditCreated(input), id }],
  });
});

const createItem = Effect.fn('SiamparkOps.Purchasing.itemCreate')(function* createItem(
  state: PurchasingState,
  value: CommandOf<'StockItemCreate'>,
  input: OpsCommandInput,
) {
  if (state.items.some((entry) => same(entry.sku, value.sku))) {
    return yield* opsConflict('A stock item with this SKU already exists');
  }
  if (value.maximum > 0 && value.maximum < value.minimum) {
    return yield* opsConflict('Maximum must not be lower than minimum');
  }
  yield* requireWarehouse(state, value.warehouseId);
  if (value.supplierId !== undefined) {
    yield* requireSupplier(state, value.supplierId);
  }
  const id = yield* mintId(StockItemIdSchema, input.resourceId);
  const { _tag: _ignored, ...fields } = value;
  const record: StockItem = { ...fields, ...auditCreated(input), id };
  return change([yield* entityIdOf(id)], { ...state, items: [...state.items, record] });
});

const updateItem = Effect.fn('SiamparkOps.Purchasing.itemUpdate')(function* updateItem(
  state: PurchasingState,
  value: CommandOf<'StockItemUpdate'>,
  input: OpsCommandInput,
) {
  const item = yield* findItem(state, value.itemId);
  const { _tag: _ignored, itemId: _id, ...patch } = value;
  const next: StockItem = auditUpdated({ ...item, ...patch }, input);
  if (next.maximum > 0 && next.maximum < next.minimum) {
    return yield* opsConflict('Maximum must not be lower than minimum');
  }
  yield* requireWarehouse(state, next.warehouseId);
  if (next.supplierId !== undefined) {
    yield* requireSupplier(state, next.supplierId);
  }
  return change([yield* entityIdOf(item.id)], {
    ...state,
    items: state.items.map((entry) => (entry.id === item.id ? next : entry)),
  });
});

const receipt = Effect.fn('SiamparkOps.Purchasing.receipt')(function* receipt(
  state: PurchasingState,
  value: CommandOf<'StockReceipt'>,
  input: OpsCommandInput,
) {
  const item = yield* findItem(state, value.itemId);
  const warehouseId = value.warehouseId ?? item.warehouseId;
  yield* requireWarehouse(state, warehouseId);
  yield* checkIncoming(state, item, value.quantity, value.batch, value.serialNumbers);
  const id = yield* mintId(StockMovementIdSchema, input.resourceId);
  const movement = movementOf(input, id, {
    date: value.date,
    itemId: item.id,
    kind: 'receipt',
    quantity: value.quantity,
    reason: value.reason,
    refs: value.refs ?? [],
    warehouseId,
    ...optional('batch', value.batch),
    ...optional('serialNumbers', value.serialNumbers),
  });
  return change([yield* entityIdOf(id)], { ...state, movements: [...state.movements, movement] });
});

const issue = Effect.fn('SiamparkOps.Purchasing.issue')(function* issue(
  state: PurchasingState,
  value: CommandOf<'StockIssue'>,
  input: OpsCommandInput,
) {
  const item = yield* findItem(state, value.itemId);
  const warehouseId = value.warehouseId ?? item.warehouseId;
  yield* requireWarehouse(state, warehouseId);
  yield* checkOutgoing(state, item, warehouseId, value.quantity, value.batch, value.serialNumbers);
  const planned =
    value.plannedIssueId === undefined
      ? undefined
      : state.plannedIssues.find((entry) => entry.id === value.plannedIssueId);
  if (value.plannedIssueId !== undefined && (planned === undefined || planned.status !== 'planned')) {
    return yield* opsConflict('The planned issue is not open');
  }
  const id = yield* mintId(StockMovementIdSchema, input.resourceId);
  const movement = movementOf(input, id, {
    date: value.date,
    itemId: item.id,
    kind: 'issue',
    quantity: -value.quantity,
    reason: value.reason,
    refs: [
      ...(value.refs ?? []),
      ...(planned?.refs ?? []).filter((ref) => !(value.refs ?? []).some((own) => own.id === ref.id)),
    ],
    warehouseId,
    ...optional('batch', value.batch),
    ...optional('serialNumbers', value.serialNumbers),
    ...optional('plannedIssueId', value.plannedIssueId),
  });
  return change([yield* entityIdOf(id)], {
    ...state,
    movements: [...state.movements, movement],
    plannedIssues: state.plannedIssues.map((entry) =>
      entry.id === value.plannedIssueId ? auditUpdated({ ...entry, status: 'issued' as const }, input) : entry,
    ),
  });
});

const transfer = Effect.fn('SiamparkOps.Purchasing.transfer')(function* transfer(
  state: PurchasingState,
  value: CommandOf<'StockTransfer'>,
  input: OpsCommandInput,
) {
  const item = yield* findItem(state, value.itemId);
  if (value.fromWarehouseId === value.toWarehouseId) {
    return yield* opsConflict('Source and target warehouse must differ');
  }
  yield* requireWarehouse(state, value.fromWarehouseId);
  yield* requireWarehouse(state, value.toWarehouseId);
  yield* checkOutgoing(state, item, value.fromWarehouseId, value.quantity, value.batch, value.serialNumbers);
  const id = yield* mintId(StockMovementIdSchema, input.resourceId);
  const movement = movementOf(input, id, {
    date: value.date,
    fromWarehouseId: value.fromWarehouseId,
    itemId: item.id,
    kind: 'transfer',
    quantity: value.quantity,
    reason: value.reason,
    refs: [],
    warehouseId: value.toWarehouseId,
    ...optional('batch', value.batch),
    ...optional('serialNumbers', value.serialNumbers),
  });
  return change([yield* entityIdOf(id)], { ...state, movements: [...state.movements, movement] });
});

const adjustment = Effect.fn('SiamparkOps.Purchasing.adjustment')(function* adjustment(
  state: PurchasingState,
  value: CommandOf<'StockAdjustment'>,
  input: OpsCommandInput,
) {
  const item = yield* findItem(state, value.itemId);
  if (value.delta === 0) {
    return yield* opsConflict('A correction must change the quantity');
  }
  const warehouseId = value.warehouseId ?? item.warehouseId;
  yield* requireWarehouse(state, warehouseId);
  if (value.delta > 0) {
    yield* checkIncoming(state, item, value.delta, value.batch, value.serialNumbers);
  } else {
    yield* checkOutgoing(state, item, warehouseId, -value.delta, value.batch, value.serialNumbers);
  }
  const id = yield* mintId(StockMovementIdSchema, input.resourceId);
  const movement = movementOf(input, id, {
    date: value.date,
    itemId: item.id,
    kind: 'adjustment',
    quantity: value.delta,
    reason: value.reason,
    refs: [],
    warehouseId,
    ...optional('batch', value.batch),
    ...optional('serialNumbers', value.serialNumbers),
  });
  return change([yield* entityIdOf(id)], { ...state, movements: [...state.movements, movement] });
});

const planIssue = Effect.fn('SiamparkOps.Purchasing.planIssue')(function* planIssue(
  state: PurchasingState,
  value: CommandOf<'StockPlannedIssueCreate'>,
  input: OpsCommandInput,
) {
  yield* findItem(state, value.itemId);
  const id = yield* mintId(StockPlannedIssueIdSchema, input.resourceId);
  const { _tag: _ignored, refs, ...fields } = value;
  return change([yield* entityIdOf(id)], {
    ...state,
    plannedIssues: [
      ...state.plannedIssues,
      { ...fields, ...auditCreated(input), id, refs: refs ?? [], status: 'planned' as const },
    ],
  });
});

const cancelPlannedIssue = Effect.fn('SiamparkOps.Purchasing.cancelPlannedIssue')(function* cancelPlannedIssue(
  state: PurchasingState,
  value: CommandOf<'StockPlannedIssueCancel'>,
  input: OpsCommandInput,
) {
  const planned = state.plannedIssues.find((entry) => entry.id === value.plannedIssueId);
  if (planned === undefined) {
    return yield* opsNotFound('Planned issue not found');
  }
  if (planned.status !== 'planned') {
    return yield* opsConflict('The planned issue is not open');
  }
  return change([yield* entityIdOf(planned.id)], {
    ...state,
    plannedIssues: state.plannedIssues.map((entry) =>
      entry.id === planned.id ? auditUpdated({ ...entry, status: 'cancelled' as const }, input) : entry,
    ),
  });
});

const lineIdOf = (input: OpsCommandInput, index: number) =>
  mintId(PurchaseLineIdSchema, `${input.resourceId}:line-${index + 1}`);

const createQuote = Effect.fn('SiamparkOps.Purchasing.quoteCreate')(function* createQuote(
  state: PurchasingState,
  value: CommandOf<'PurchaseQuoteCreate'>,
  input: OpsCommandInput,
) {
  yield* requireSupplier(state, value.supplierId);
  yield* requireItems(
    state,
    value.lines.map((line) => line.itemId),
  );
  if (state.quotes.some((entry) => entry.supplierId === value.supplierId && same(entry.number, value.number))) {
    return yield* opsConflict('This supplier quote is already recorded');
  }
  const id = yield* mintId(SupplierQuoteIdSchema, input.resourceId);
  const lines = yield* Effect.forEach(value.lines, (line, index) =>
    Effect.map(lineIdOf(input, index), (lineId) => ({ ...line, id: lineId })),
  );
  const { _tag: _ignored, lines: _lines, ...fields } = value;
  return change([yield* entityIdOf(id)], {
    ...state,
    quotes: [...state.quotes, { ...fields, ...auditCreated(input), id, lines, status: 'received' as const }],
  });
});

const rejectQuote = Effect.fn('SiamparkOps.Purchasing.quoteReject')(function* rejectQuote(
  state: PurchasingState,
  value: CommandOf<'PurchaseQuoteReject'>,
  input: OpsCommandInput,
) {
  const quote = state.quotes.find((entry) => entry.id === value.quoteId);
  if (quote === undefined) {
    return yield* opsNotFound('Supplier quote not found');
  }
  if (quote.status !== 'received') {
    return yield* opsConflict('Only a received quote can be rejected');
  }
  return change([yield* entityIdOf(quote.id)], {
    ...state,
    quotes: state.quotes.map((entry) =>
      entry.id === quote.id
        ? auditUpdated({ ...entry, status: 'rejected' as const, ...optional('note', value.note ?? entry.note) }, input)
        : entry,
    ),
  });
});

const nextOrderNumber = (state: PurchasingState, input: OpsCommandInput) => {
  const year = today(input).slice(0, 4);
  let sequence = state.orders.length + 1;
  const taken = new Set(state.orders.map((order) => order.number));
  while (taken.has(`OBJ-${year}-${String(sequence).padStart(4, '0')}`)) {
    sequence += 1;
  }
  return `OBJ-${year}-${String(sequence).padStart(4, '0')}`;
};

const historyOf = (
  input: OpsCommandInput,
  event: PurchaseOrderHistory['event'],
  status: PurchaseOrder['status'],
  note?: string,
): PurchaseOrderHistory => ({ at: input.now, by: input.actor, event, status, ...optional('note', note) });

const newOrder = (
  state: PurchasingState,
  input: OpsCommandInput,
  id: PurchaseOrder['id'],
  fields: Pick<PurchaseOrder, 'currency' | 'lines' | 'supplierId' | 'warehouseId'> &
    Partial<Pick<PurchaseOrder, 'expectedDate' | 'note' | 'quoteId'>>,
): PurchaseOrder => ({
  ...fields,
  ...auditCreated(input),
  deliveries: [],
  history: [historyOf(input, 'created', 'draft', fields.note)],
  id,
  invoices: [],
  number: nextOrderNumber(state, input),
  status: 'draft',
});

const createOrder = Effect.fn('SiamparkOps.Purchasing.orderCreate')(function* createOrder(
  state: PurchasingState,
  value: CommandOf<'PurchaseOrderCreate'>,
  input: OpsCommandInput,
) {
  yield* requireSupplier(state, value.supplierId);
  yield* requireWarehouse(state, value.warehouseId);
  yield* requireItems(
    state,
    value.lines.map((line) => line.itemId),
  );
  const id = yield* mintId(PurchaseOrderIdSchema, input.resourceId);
  const lines = yield* Effect.forEach(value.lines, (line, index) =>
    Effect.map(lineIdOf(input, index), (lineId): PurchaseOrderLine => ({ ...line, id: lineId, receivedQuantity: 0 })),
  );
  const order = newOrder(state, input, id, {
    currency: value.currency,
    lines,
    supplierId: value.supplierId,
    warehouseId: value.warehouseId,
    ...optional('expectedDate', value.expectedDate),
    ...optional('note', value.note),
  });
  return change([yield* entityIdOf(id)], { ...state, orders: [...state.orders, order] });
});

/** S06-01: the order keeps the quoted item, quantity, price and the link to the quote. */
const createOrderFromQuote = Effect.fn('SiamparkOps.Purchasing.orderFromQuote')(function* createOrderFromQuote(
  state: PurchasingState,
  value: CommandOf<'PurchaseOrderCreateFromQuote'>,
  input: OpsCommandInput,
) {
  const quote = state.quotes.find((entry) => entry.id === value.quoteId);
  if (quote === undefined) {
    return yield* opsNotFound('Supplier quote not found');
  }
  if (quote.status !== 'received') {
    return yield* opsConflict('The quote was already accepted or rejected');
  }
  yield* requireWarehouse(state, value.warehouseId);
  const id = yield* mintId(PurchaseOrderIdSchema, input.resourceId);
  const lines = yield* Effect.forEach(quote.lines, (line, index) =>
    Effect.map(lineIdOf(input, index), (lineId): PurchaseOrderLine => ({
      description: line.description,
      id: lineId,
      quantity: line.quantity,
      quoteLineId: line.id,
      receivedQuantity: 0,
      unitPriceMinor: line.unitPriceMinor,
      ...optional('itemId', line.itemId),
    })),
  );
  const order = newOrder(state, input, id, {
    currency: quote.currency,
    lines,
    quoteId: quote.id,
    supplierId: quote.supplierId,
    warehouseId: value.warehouseId,
    ...optional('expectedDate', value.expectedDate),
    ...optional('note', value.note),
  });
  return change([yield* entityIdOf(id), yield* entityIdOf(quote.id)], {
    ...state,
    orders: [...state.orders, order],
    quotes: state.quotes.map((entry) =>
      entry.id === quote.id
        ? auditUpdated({ ...entry, purchaseOrderId: id, status: 'accepted' as const }, input)
        : entry,
    ),
  });
});

const allowedTransitions: Readonly<
  Record<CommandOf<'PurchaseOrderTransition'>['to'], ReadonlyArray<PurchaseOrder['status']>>
> = {
  approved: ['draft'],
  cancelled: ['draft', 'approved', 'ordered'],
  completed: ['partially_delivered'],
  ordered: ['approved'],
};

const transitionOrder = Effect.fn('SiamparkOps.Purchasing.orderTransition')(function* transitionOrder(
  state: PurchasingState,
  value: CommandOf<'PurchaseOrderTransition'>,
  input: OpsCommandInput,
) {
  const order = yield* findOrder(state, value.orderId);
  if (!allowedTransitions[value.to].includes(order.status)) {
    return yield* opsConflict(`Order in status ${order.status} cannot move to ${value.to}`);
  }
  if (value.to === 'cancelled' && order.deliveries.length > 0) {
    return yield* opsConflict('An order with deliveries cannot be cancelled');
  }
  if (value.to === 'completed' && (value.note === undefined || value.note === '')) {
    return yield* opsConflict('Closing an order with an open remainder needs a reason');
  }
  const next: PurchaseOrder = auditUpdated(
    { ...order, history: [...order.history, historyOf(input, value.to, value.to, value.note)], status: value.to },
    input,
  );
  return change([yield* entityIdOf(order.id)], {
    ...state,
    orders: state.orders.map((entry) => (entry.id === order.id ? next : entry)),
  });
});

/** S06-02: records a (partial) delivery, receives stock items into the order's warehouse. */
const receiveOrder = Effect.fn('SiamparkOps.Purchasing.orderReceive')(function* receiveOrder(
  state: PurchasingState,
  value: CommandOf<'PurchaseOrderReceive'>,
  input: OpsCommandInput,
) {
  const order = yield* findOrder(state, value.orderId);
  if (order.status !== 'ordered' && order.status !== 'partially_delivered') {
    return yield* opsConflict('Only an ordered purchase order can be received');
  }
  if (new Set(value.lines.map((line) => line.lineId)).size !== value.lines.length) {
    return yield* opsConflict('Each order line may appear once per delivery');
  }
  let working: PurchasingState = state;
  const movementIds: StockMovement['id'][] = [];
  const received = new Map<string, number>();
  const prices = new Map<string, number>();
  for (const [index, delivered] of value.lines.entries()) {
    const line = order.lines.find((entry) => entry.id === delivered.lineId);
    if (line === undefined) {
      return yield* opsNotFound('Order line not found');
    }
    if (delivered.quantity > line.quantity - line.receivedQuantity) {
      return yield* opsConflict('Delivered quantity exceeds the remaining quantity');
    }
    received.set(line.id, delivered.quantity);
    if (line.itemId === undefined) {
      continue;
    }
    const item = yield* findItem(working, line.itemId);
    yield* checkIncoming(working, item, delivered.quantity, delivered.batch, delivered.serialNumbers);
    const movementId = yield* mintId(StockMovementIdSchema, `${input.resourceId}:receipt-${index + 1}`);
    const ref: StockRef = { id: order.id, kind: 'purchase_order', label: order.number };
    const movement = movementOf(input, movementId, {
      date: value.date,
      itemId: item.id,
      kind: 'receipt',
      purchaseOrderId: order.id,
      quantity: delivered.quantity,
      reason: `Příjem z objednávky ${order.number}${value.deliveryNote === undefined ? '' : `, dodací list ${value.deliveryNote}`}`,
      refs: [ref],
      warehouseId: order.warehouseId,
      ...optional('batch', delivered.batch),
      ...optional('serialNumbers', delivered.serialNumbers),
    });
    movementIds.push(movementId);
    prices.set(item.id, line.unitPriceMinor);
    working = { ...working, movements: [...working.movements, movement] };
  }
  const lines = order.lines.map((line) => ({
    ...line,
    receivedQuantity: line.receivedQuantity + (received.get(line.id) ?? 0),
  }));
  const complete = lines.every((line) => line.receivedQuantity >= line.quantity);
  const status: PurchaseOrder['status'] = complete ? 'completed' : 'partially_delivered';
  const delivery: PurchaseDelivery = {
    date: value.date,
    id: `${input.resourceId}:delivery`,
    lines: value.lines,
    movementIds,
    receivedAt: input.now,
    receivedBy: input.actor,
    ...optional('deliveryNote', value.deliveryNote),
  };
  const history = [
    ...order.history,
    historyOf(
      input,
      'delivery',
      status,
      value.deliveryNote === undefined ? undefined : `Dodací list ${value.deliveryNote}`,
    ),
    ...(complete ? [historyOf(input, 'completed', 'completed')] : []),
  ];
  const next: PurchaseOrder = auditUpdated(
    { ...order, deliveries: [...order.deliveries, delivery], history, lines, status },
    input,
  );
  const entityIds = [yield* entityIdOf(order.id), ...(yield* Effect.forEach(movementIds, entityIdOf))];
  return change(entityIds, {
    ...working,
    items: working.items.map((item) =>
      prices.has(item.id) ? auditUpdated({ ...item, lastPriceMinor: prices.get(item.id) ?? 0 }, input) : item,
    ),
    orders: working.orders.map((entry) => (entry.id === order.id ? next : entry)),
  });
});

/** S06: link of the received supplier invoice (reference only; the invoice itself lives in finance). */
const linkInvoice = Effect.fn('SiamparkOps.Purchasing.orderLinkInvoice')(function* linkInvoice(
  state: PurchasingState,
  value: CommandOf<'PurchaseOrderLinkInvoice'>,
  input: OpsCommandInput,
) {
  const order = yield* findOrder(state, value.orderId);
  if (order.status === 'draft' || order.status === 'cancelled') {
    return yield* opsConflict('Invoices can be linked only to an approved order');
  }
  if (order.invoices.some((entry) => same(entry.number, value.number))) {
    return yield* opsConflict('This invoice is already linked');
  }
  const { _tag: _ignored, orderId: _order, ...fields } = value;
  const next: PurchaseOrder = auditUpdated(
    {
      ...order,
      history: [...order.history, historyOf(input, 'invoice', order.status, `Faktura ${value.number}`)],
      invoices: [...order.invoices, { ...fields, linkedAt: input.now, linkedBy: input.actor }],
    },
    input,
  );
  return change([yield* entityIdOf(order.id)], {
    ...state,
    orders: state.orders.map((entry) => (entry.id === order.id ? next : entry)),
  });
});

/** Pure reducer: applies one command to the `purchasing` state. Persistence decides when it is saved. */
export const evolvePurchasing = (state: PurchasingState, command: PurchasingCommand, input: OpsCommandInput) =>
  Match.value(command).pipe(
    Match.tag('StockWarehouseCreate', (value) => createWarehouse(state, value, input)),
    Match.tag('PurchaseSupplierCreate', (value) => createSupplier(state, value, input)),
    Match.tag('StockItemCreate', (value) => createItem(state, value, input)),
    Match.tag('StockItemUpdate', (value) => updateItem(state, value, input)),
    Match.tag('StockReceipt', (value) => receipt(state, value, input)),
    Match.tag('StockIssue', (value) => issue(state, value, input)),
    Match.tag('StockTransfer', (value) => transfer(state, value, input)),
    Match.tag('StockAdjustment', (value) => adjustment(state, value, input)),
    Match.tag('StockPlannedIssueCreate', (value) => planIssue(state, value, input)),
    Match.tag('StockPlannedIssueCancel', (value) => cancelPlannedIssue(state, value, input)),
    Match.tag('PurchaseQuoteCreate', (value) => createQuote(state, value, input)),
    Match.tag('PurchaseQuoteReject', (value) => rejectQuote(state, value, input)),
    Match.tag('PurchaseOrderCreate', (value) => createOrder(state, value, input)),
    Match.tag('PurchaseOrderCreateFromQuote', (value) => createOrderFromQuote(state, value, input)),
    Match.tag('PurchaseOrderTransition', (value) => transitionOrder(state, value, input)),
    Match.tag('PurchaseOrderReceive', (value) => receiveOrder(state, value, input)),
    Match.tag('PurchaseOrderLinkInvoice', (value) => linkInvoice(state, value, input)),
    Match.exhaustive,
  );

export const purchasingAgenda = defineAgenda({
  commandSchema: PurchasingCommandSchema,
  empty: emptyPurchasingState,
  evolve: evolvePurchasing,
  id: 'purchasing',
  sensitivity: 'restricted',
  stateSchema: PurchasingStateSchema,
});
