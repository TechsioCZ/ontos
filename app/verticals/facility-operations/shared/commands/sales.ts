// Facility operations — prodej (S06): nabídka zákazníkovi → prodejní objednávka → dodání → vystavená faktura (návrh).
// Lives in the `purchasing` agenda state (salesQuotes / salesOrders); tags are prefixed Sales*. The issued invoice
// itself is created in Finance (CreateInvoiceDraft) from a snapshot of the order; SalesOrderLinkInvoice records it.
import { DateTime, Effect, Match, Schema } from 'effect';
import {
  optionalField,
  IsoDateSchema,
  MinorAmountSchema,
  NoteSchema,
  PropertyRefSchema,
  TextSchema,
  auditCreated,
  auditUpdated,
  entityIdOf,
  mintId,
  opsConflict,
  opsNotFound,
} from '../domain/common.ts';
import type { OpsCommandCall, OpsCommandInput } from '../domain/common.ts';
import {
  PurchaseLineIdSchema,
  QuantitySchema,
  SalesCustomerSchema,
  SalesOrderIdSchema,
  SalesQuoteIdSchema,
  SalesVatRateSchema,
  StockItemIdSchema,
} from '../domain/purchasing.ts';
import type { PurchasingState, SalesLine, SalesOrder, SalesOrderHistory, SalesQuote } from '../domain/purchasing.ts';

const SalesLineInputSchema = Schema.Struct({
  description: TextSchema(300),
  itemId: Schema.optionalKey(StockItemIdSchema),
  quantity: QuantitySchema,
  unitPriceMinor: MinorAmountSchema,
  vatRate: SalesVatRateSchema,
});
const SalesLinesInputSchema = Schema.Array(SalesLineInputSchema).check(Schema.isMinLength(1), Schema.isMaxLength(100));

const quoteFields = {
  customer: SalesCustomerSchema,
  date: IsoDateSchema,
  lines: SalesLinesInputSchema,
  note: Schema.optionalKey(NoteSchema),
  related: Schema.optionalKey(PropertyRefSchema),
  validUntil: Schema.optionalKey(IsoDateSchema),
};

export const salesCommandSchemas = [
  /** Nabídka zákazníkovi (protistrana z adresáře, položky/služby, množství, cena, DPH, datum). */
  Schema.TaggedStruct('SalesQuoteCreate', { ...quoteFields, status: Schema.Literals(['draft', 'sent']) }),
  /** Úprava nabídky. Hotová objednávka i faktura mají vlastní kopii řádků, úprava je nemění (S06). */
  Schema.TaggedStruct('SalesQuoteUpdate', { ...quoteFields, quoteId: SalesQuoteIdSchema }),
  Schema.TaggedStruct('SalesQuoteReject', { note: Schema.optionalKey(NoteSchema), quoteId: SalesQuoteIdSchema }),
  /** Z nabídky vznikne prodejní objednávka: řádky, ceny a vazba na nabídku se zkopírují. */
  Schema.TaggedStruct('SalesOrderCreateFromQuote', {
    expectedDate: Schema.optionalKey(IsoDateSchema),
    note: Schema.optionalKey(NoteSchema),
    quoteId: SalesQuoteIdSchema,
  }),
  Schema.TaggedStruct('SalesOrderTransition', {
    note: Schema.optionalKey(NoteSchema),
    orderId: SalesOrderIdSchema,
    to: Schema.Literals(['approved', 'ordered', 'cancelled', 'completed']),
  }),
  /** Dodání zákazníkovi (předání služby / zboží): množství po řádcích; zbytek zůstává v nevyřízených. */
  Schema.TaggedStruct('SalesOrderDeliver', {
    date: IsoDateSchema,
    lines: Schema.Array(Schema.Struct({ lineId: PurchaseLineIdSchema, quantity: QuantitySchema })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(100),
    ),
    note: Schema.optionalKey(NoteSchema),
    orderId: SalesOrderIdSchema,
  }),
  /** Records the issued invoice draft Finance created from this order (number + Finance resource id). */
  Schema.TaggedStruct('SalesOrderLinkInvoice', {
    invoiceId: TextSchema(300),
    number: TextSchema(64),
    orderId: SalesOrderIdSchema,
    totalMinor: Schema.optionalKey(MinorAmountSchema),
  }),
] as const;

export const SalesCommandSchema = Schema.Union(salesCommandSchemas);
export type SalesCommand = typeof SalesCommandSchema.Type;
type CommandOf<Tag extends SalesCommand['_tag']> = Extract<SalesCommand, { readonly _tag: Tag }>;

type OptionalText<Key extends string> = Partial<Record<Key, string>>;
const optional = <Key extends string>(key: Key, value: string | undefined) => {
  const fields: OptionalText<Key> = {};
  if (value !== undefined && value !== '') {
    fields[key] = value;
  }
  return fields;
};

const quotesOf = (state: PurchasingState) => state.salesQuotes ?? [];
const ordersOf = (state: PurchasingState) => state.salesOrders ?? [];

const findQuote = (state: PurchasingState, quoteId: string) =>
  Effect.fromNullishOr(quotesOf(state).find((entry) => entry.id === quoteId)).pipe(
    Effect.catchTag('NoSuchElementError', () => Effect.fail(opsNotFound('Sales quote not found'))),
  );
const findOrder = (state: PurchasingState, orderId: string) =>
  Effect.fromNullishOr(ordersOf(state).find((entry) => entry.id === orderId)).pipe(
    Effect.catchTag('NoSuchElementError', () => Effect.fail(opsNotFound('Sales order not found'))),
  );

/** Next number in a yearly series, e.g. `NAB-SP-2026-0003` / `PRO-2026-0012`. */
const nextNumber = (prefix: string, year: string, existing: readonly { readonly number: string }[]) => {
  const head = `${prefix}-${year}-`;
  let highest = 0;
  for (const entry of existing) {
    const value = entry.number.startsWith(head) ? Number(entry.number.slice(head.length)) : 0;
    if (Number.isSafeInteger(value) && value > highest) {
      highest = value;
    }
  }
  return `${head}${String(highest + 1).padStart(4, '0')}`;
};

const linesWithIds = (input: OpsCommandInput, lines: CommandOf<'SalesQuoteCreate'>['lines']) =>
  Effect.forEach(
    lines,
    (line, index) =>
      Effect.map(mintId(PurchaseLineIdSchema, `${input.resourceId}:line-${index + 1}`), (id): SalesLine => ({
        description: line.description,
        id,
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
        vatRate: line.vatRate,
        ...optionalField('itemId', line.itemId),
      })),
    { concurrency: 1 },
  );

const historyOf = (
  input: OpsCommandInput,
  event: SalesOrderHistory['event'],
  status: SalesOrder['status'],
  note?: string,
): SalesOrderHistory => ({ at: input.now, by: input.actor, event, status, ...optional('note', note) });

const result = (id: string, state: PurchasingState) =>
  Effect.map(entityIdOf(id), (entity) => ({ entityIds: [entity], state }));

const pragueYearFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric' });
/** Business year of the command, including the Prague year boundary. */
const commandYear = (input: OpsCommandInput) => pragueYearFormatter.format(DateTime.toEpochMillis(input.now));

const createQuote = Effect.fn('FacilityOperations.Sales.createQuote')(function* createQuote(
  state: PurchasingState,
  { input, value }: OpsCommandCall<CommandOf<'SalesQuoteCreate'>>,
) {
  if (value.validUntil !== undefined && value.validUntil < value.date) {
    return yield* opsConflict('A quote cannot expire before its date');
  }
  const id = yield* mintId(SalesQuoteIdSchema, input.resourceId);
  const quote: SalesQuote = {
    ...auditCreated(input),
    currency: 'CZK',
    customer: value.customer,
    date: value.date,
    id,
    lines: yield* linesWithIds(input, value.lines),
    number: nextNumber('NAB-SP', value.date.slice(0, 4), quotesOf(state)),
    status: value.status,
    ...optional('validUntil', value.validUntil),
    ...optional('note', value.note),
    ...optionalField('related', value.related),
  };
  return yield* result(id, { ...state, salesQuotes: [...quotesOf(state), quote] });
});

const updateQuote = Effect.fn('FacilityOperations.Sales.updateQuote')(function* updateQuote(
  state: PurchasingState,
  value: CommandOf<'SalesQuoteUpdate'>,
  input: OpsCommandInput,
) {
  const quote = yield* findQuote(state, value.quoteId);
  if (quote.status === 'rejected') {
    return yield* opsConflict('A rejected quote is read-only');
  }
  const { note: _note, related: _related, validUntil: _validUntil, ...base } = quote;
  const cleared: SalesQuote = auditUpdated(
    {
      ...base,
      customer: value.customer,
      date: value.date,
      lines: yield* linesWithIds(input, value.lines),
      ...optional('validUntil', value.validUntil),
      ...optional('note', value.note),
      ...optionalField('related', value.related),
    },
    input,
  );
  return yield* result(quote.id, {
    ...state,
    salesQuotes: quotesOf(state).map((entry) => (entry.id === quote.id ? cleared : entry)),
  });
});

const rejectQuote = Effect.fn('FacilityOperations.Sales.rejectQuote')(function* rejectQuote(
  state: PurchasingState,
  value: CommandOf<'SalesQuoteReject'>,
  input: OpsCommandInput,
) {
  const quote = yield* findQuote(state, value.quoteId);
  if (quote.status === 'accepted' || quote.status === 'rejected') {
    return yield* opsConflict(`A quote in status ${quote.status} cannot be rejected`);
  }
  const next: SalesQuote = auditUpdated(
    { ...quote, status: 'rejected', ...optional('note', value.note ?? quote.note) },
    input,
  );
  return yield* result(quote.id, {
    ...state,
    salesQuotes: quotesOf(state).map((entry) => (entry.id === quote.id ? next : entry)),
  });
});

const createOrderFromQuote = Effect.fn('FacilityOperations.Sales.createOrderFromQuote')(function* createOrderFromQuote(
  state: PurchasingState,
  { input, value }: OpsCommandCall<CommandOf<'SalesOrderCreateFromQuote'>>,
) {
  const quote = yield* findQuote(state, value.quoteId);
  if (quote.status === 'rejected' || quote.salesOrderId !== undefined) {
    return yield* opsConflict('The quote is rejected or already has a sales order');
  }
  const id = yield* mintId(SalesOrderIdSchema, input.resourceId);
  const order: SalesOrder = {
    ...auditCreated(input),
    currency: quote.currency,
    customer: quote.customer,
    deliveries: [],
    history: [historyOf(input, 'created', 'draft', `Z nabídky ${quote.number}`)],
    id,
    invoices: [],
    lines: yield* Effect.forEach(
      quote.lines,
      (line, index) =>
        Effect.map(mintId(PurchaseLineIdSchema, `${input.resourceId}:line-${index + 1}`), (lineId) => ({
          ...line,
          deliveredQuantity: 0,
          id: lineId,
          quoteLineId: line.id,
        })),
      { concurrency: 1 },
    ),
    number: nextNumber('PRO', commandYear(input), ordersOf(state)),
    quoteId: quote.id,
    quoteNumber: quote.number,
    status: 'draft',
    ...optional('expectedDate', value.expectedDate),
    ...optional('note', value.note),
    ...optionalField('related', quote.related),
  };
  const accepted: SalesQuote = auditUpdated({ ...quote, salesOrderId: id, status: 'accepted' }, input);
  return {
    entityIds: [yield* entityIdOf(id), yield* entityIdOf(quote.id)],
    state: {
      ...state,
      salesOrders: [...ordersOf(state), order],
      salesQuotes: quotesOf(state).map((entry) => (entry.id === quote.id ? accepted : entry)),
    },
  };
});

const allowedTransitions = {
  approved: ['draft'],
  cancelled: ['draft', 'approved', 'ordered'],
  completed: ['partially_delivered'],
  ordered: ['approved'],
} satisfies Readonly<Record<CommandOf<'SalesOrderTransition'>['to'], readonly SalesOrder['status'][]>>;

const replaceOrder = (state: PurchasingState, order: SalesOrder): PurchasingState => ({
  ...state,
  salesOrders: ordersOf(state).map((entry) => (entry.id === order.id ? order : entry)),
});

const transitionOrder = Effect.fn('FacilityOperations.Sales.transitionOrder')(function* transitionOrder(
  state: PurchasingState,
  value: CommandOf<'SalesOrderTransition'>,
  input: OpsCommandInput,
) {
  const order = yield* findOrder(state, value.orderId);
  if (!allowedTransitions[value.to].some((previous) => previous === order.status)) {
    return yield* opsConflict(`Sales order in status ${order.status} cannot move to ${value.to}`);
  }
  if (value.to === 'cancelled' && order.deliveries.length > 0) {
    return yield* opsConflict('A sales order with deliveries cannot be cancelled');
  }
  if (value.to === 'completed' && (value.note === undefined || value.note === '')) {
    return yield* opsConflict('Closing a sales order with an open remainder needs a reason');
  }
  const next: SalesOrder = auditUpdated(
    { ...order, history: [...order.history, historyOf(input, value.to, value.to, value.note)], status: value.to },
    input,
  );
  return yield* result(order.id, replaceOrder(state, next));
});

const deliver = Effect.fn('FacilityOperations.Sales.deliver')(function* deliver(
  state: PurchasingState,
  value: CommandOf<'SalesOrderDeliver'>,
  input: OpsCommandInput,
) {
  const order = yield* findOrder(state, value.orderId);
  if (order.status !== 'ordered' && order.status !== 'partially_delivered') {
    return yield* opsConflict('Only a confirmed (objednáno) or partially delivered order can be delivered');
  }
  const lines = [...order.lines];
  for (const delivered of value.lines) {
    const index = lines.findIndex((line) => line.id === delivered.lineId);
    const line = lines[index];
    if (line === undefined) {
      return yield* opsNotFound('Sales order line not found');
    }
    if (line.deliveredQuantity + delivered.quantity > line.quantity) {
      return yield* opsConflict('Delivered quantity would exceed the ordered quantity');
    }
    lines[index] = { ...line, deliveredQuantity: line.deliveredQuantity + delivered.quantity };
  }
  const complete = lines.every((line) => line.deliveredQuantity >= line.quantity);
  const status = complete ? 'completed' : 'partially_delivered';
  const next: SalesOrder = auditUpdated(
    {
      ...order,
      deliveries: [
        ...order.deliveries,
        {
          date: value.date,
          id: `${input.resourceId}:delivery`,
          lines: value.lines,
          recordedAt: input.now,
          recordedBy: input.actor,
          ...optional('note', value.note),
        },
      ],
      history: [...order.history, historyOf(input, complete ? 'completed' : 'delivery', status, value.note)],
      lines,
      status,
    },
    input,
  );
  return yield* result(order.id, replaceOrder(state, next));
});

const linkInvoice = Effect.fn('FacilityOperations.Sales.linkInvoice')(function* linkInvoice(
  state: PurchasingState,
  value: CommandOf<'SalesOrderLinkInvoice'>,
  input: OpsCommandInput,
) {
  const order = yield* findOrder(state, value.orderId);
  if (order.status === 'draft' || order.status === 'cancelled') {
    return yield* opsConflict('Only an approved sales order can be invoiced');
  }
  if (order.invoices.some((invoice) => invoice.invoiceId === value.invoiceId)) {
    return yield* result(order.id, state);
  }
  const next: SalesOrder = auditUpdated(
    {
      ...order,
      history: [...order.history, historyOf(input, 'invoice', order.status, value.number)],
      invoices: [
        ...order.invoices,
        {
          invoiceId: value.invoiceId,
          linkedAt: input.now,
          linkedBy: input.actor,
          number: value.number,
          ...optionalField('totalMinor', value.totalMinor),
        },
      ],
    },
    input,
  );
  return yield* result(order.id, replaceOrder(state, next));
});

export const evolveSales = (state: PurchasingState, command: SalesCommand, input: OpsCommandInput) =>
  Match.value(command).pipe(
    Match.tag('SalesQuoteCreate', (value) => createQuote(state, { input, value })),
    Match.tag('SalesQuoteUpdate', (value) => updateQuote(state, value, input)),
    Match.tag('SalesQuoteReject', (value) => rejectQuote(state, value, input)),
    Match.tag('SalesOrderCreateFromQuote', (value) => createOrderFromQuote(state, { input, value })),
    Match.tag('SalesOrderTransition', (value) => transitionOrder(state, value, input)),
    Match.tag('SalesOrderDeliver', (value) => deliver(state, value, input)),
    Match.tag('SalesOrderLinkInvoice', (value) => linkInvoice(state, value, input)),
    Match.exhaustive,
  );

/** Open remainder of a sales order (ordered − delivered), per line. */
export const salesRemainder = (order: SalesOrder) =>
  order.lines.flatMap((line) => {
    const remaining = line.quantity - line.deliveredQuantity;
    return remaining > 0 ? [{ line, remaining }] : [];
  });
