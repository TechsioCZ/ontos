// AREA: imports (C03, C04) — owned by the crm-imports lane. Command schemas + reducer.
// The CSV text travels in the command; the server parses and validates it with the same pure parser the browser
// preview uses (shared/imports/csv.ts) and applies it with shared/imports/engine.ts. Orders are a read-only
// projection of the source system: no command creates or edits an order's business data.
import { Effect, Match, Schema } from 'effect';
import { EntityIdSchema, ShortTextSchema } from '../domain/common.ts';
import type { CustomerLink, ImportedOrder, ImportsSlice, PairingChange } from '../domain/imports.ts';
import type { CrmState } from '../domain/state.ts';
import { parseOrdersCsv } from '../imports/csv.ts';
import { importOrders } from '../imports/engine.ts';
import type { CommandContext, Reducer } from './context.ts';
import { conflict, invalid, newId, notFound, requireWriteAll } from './context.ts';

/** CSV text of one import (≈ a few thousand rows at most in the demo). */
const CsvTextSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400_000));
const ReasonSchema = Schema.Trim.check(Schema.isMinLength(3), Schema.isMaxLength(2000));

export const importsCommandSchemas = [
  /** Approve "external customer id X of source S is client Y" (C04-01); pairs waiting orders of that id. */
  Schema.TaggedStruct('LinkExternalCustomer', {
    clientId: EntityIdSchema,
    externalCustomerId: ShortTextSchema,
    source: ShortTextSchema,
  }),
  /** Import orders and status changes from a crm-orders-csv-v1 file (C03). */
  Schema.TaggedStruct('ImportOrdersCsv', {
    csv: CsvTextSchema,
    fileName: ShortTextSchema,
  }),
  /** Manual pairing (or correction of a pairing) with a reason; optionally approves the customer link (C04). */
  Schema.TaggedStruct('PairOrder', {
    approveCustomerLink: Schema.optionalKey(Schema.Boolean),
    clientId: EntityIdSchema,
    orderId: EntityIdSchema,
    reason: ReasonSchema,
  }),
  /** Removes a wrong pairing; the order goes back to the unpaired queue, history keeps both bindings (C04). */
  Schema.TaggedStruct('UnpairOrder', {
    orderId: EntityIdSchema,
    reason: ReasonSchema,
  }),
  /** Decides a status event flagged "vyžaduje kontrolu": apply it as the current state, or dismiss it (C03). */
  Schema.TaggedStruct('ResolveOrderStatusEvent', {
    decision: Schema.Literals(['apply', 'dismiss']),
    eventIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    orderId: EntityIdSchema,
    reason: ReasonSchema,
  }),
  /** Decides a suspected cross-source duplicate: confirm it (stays out of totals) or mark it distinct (C03-05). */
  Schema.TaggedStruct('ResolveOrderDuplicate', {
    decision: Schema.Literals(['confirmed_duplicate', 'distinct']),
    orderId: EntityIdSchema,
    reason: ReasonSchema,
  }),
] as const;
export const ImportsCommandSchema = Schema.Union(importsCommandSchemas);
export type ImportsCommand = typeof ImportsCommandSchema.Type;

const withImports = (state: CrmState, imports: ImportsSlice): CrmState => ({ ...state, imports });

const findOrder = (state: CrmState, orderId: string) => {
  const order = state.imports.orders.find((entry) => entry.id === orderId);
  return order === undefined ? notFound('Objednávka neexistuje') : Effect.succeed(order);
};

const replaceOrder = (orders: readonly ImportedOrder[], next: ImportedOrder) =>
  orders.map((order) => (order.id === next.id ? next : order));

const pairedOrder = (order: ImportedOrder, clientId: string): ImportedOrder => {
  const { candidates: _candidates, ...rest } = order;
  return { ...rest, clientId, pairing: 'paired' };
};

/** Pairs every not-yet-paired order of the linked external customer id (approved correlation, C04-01). */
const applyLink = (imports: ImportsSlice, link: CustomerLink, context: CommandContext, skipOrderId?: string) => {
  const history: PairingChange[] = [];
  const orders = imports.orders.map((order) => {
    if (
      order.id === skipOrderId ||
      order.pairing === 'paired' ||
      order.source !== link.source ||
      order.externalCustomerId !== link.externalCustomerId
    ) {
      return order;
    }
    history.push({
      at: context.now,
      by: context.viewer.principalId,
      id: newId(context, `link-${order.id}`),
      orderId: order.id,
      reason: `Schválená vazba zákaznického ID ${link.externalCustomerId} (${link.source})`,
      toClientId: link.clientId,
      via: 'customer_link',
    });
    return pairedOrder(order, link.clientId);
  });
  return { imports: { ...imports, orders, pairingHistory: [...imports.pairingHistory, ...history] }, paired: history };
};

const requireClient = (state: CrmState, clientId: string) =>
  state.clients.items.some((client) => client.id === clientId) ? Effect.void : notFound('Klient neexistuje');

const newLink = (
  context: CommandContext,
  clientId: string,
  source: string,
  externalCustomerId: string,
  state?: CrmState,
): CustomerLink => {
  const partyRef = state?.clients.items.find((client) => client.id === clientId)?.partyRef;
  return {
    ...(partyRef?.counterpartyId === undefined
      ? {}
      : { counterpartyId: partyRef.counterpartyId, partyId: partyRef.partyId }),
    clientId,
    createdAt: context.now,
    createdBy: context.viewer.principalId,
    externalCustomerId,
    source,
  };
};

export const applyImportsCommand: Reducer<ImportsCommand> = (state, command, context) =>
  Match.value(command).pipe(
    Match.tag('LinkExternalCustomer', (value) =>
      Effect.gen(function* linkExternalCustomer() {
        yield* requireWriteAll(context);
        yield* requireClient(state, value.clientId);
        if (
          state.imports.customerLinks.some(
            (link) => link.source === value.source && link.externalCustomerId === value.externalCustomerId,
          )
        ) {
          return yield* conflict('Toto externí zákaznické ID je již propojeno');
        }
        const link = newLink(context, value.clientId, value.source, value.externalCustomerId, state);
        const linked = applyLink(
          { ...state.imports, customerLinks: [...state.imports.customerLinks, link] },
          link,
          context,
        );
        return {
          entityIds: [value.clientId, ...linked.paired.map((change) => change.orderId)],
          state: withImports(state, linked.imports),
        };
      }),
    ),
    Match.tag('ImportOrdersCsv', (value) =>
      Effect.gen(function* importOrdersCsv() {
        yield* requireWriteAll(context);
        const parsed = parseOrdersCsv(value.csv);
        if (parsed.fileError !== undefined) {
          return yield* invalid(parsed.fileError);
        }
        if (parsed.rows.length === 0) {
          return yield* invalid('Soubor neobsahuje žádné řádky s daty');
        }
        const batchId = newId(context, 'batch');
        const result = importOrders(state.imports, state.clients, parsed, {
          batchId,
          by: context.viewer.principalId,
          fileName: value.fileName,
          newId: (suffix) => newId(context, suffix),
          now: context.now,
        });
        return { entityIds: [batchId, ...result.touchedOrderIds], state: withImports(state, result.slice) };
      }),
    ),
    Match.tag('PairOrder', (value) =>
      Effect.gen(function* pairOrder() {
        yield* requireWriteAll(context);
        const order = yield* findOrder(state, value.orderId);
        yield* requireClient(state, value.clientId);
        if (order.pairing === 'paired' && order.clientId === value.clientId) {
          return yield* conflict('Objednávka už je tomuto klientovi přiřazena');
        }
        const change: PairingChange = {
          at: context.now,
          by: context.viewer.principalId,
          id: newId(context, 'pairing'),
          orderId: order.id,
          reason: value.reason,
          toClientId: value.clientId,
          via: 'manual',
          ...(order.clientId === undefined ? {} : { fromClientId: order.clientId }),
        };
        let imports: ImportsSlice = {
          ...state.imports,
          orders: replaceOrder(state.imports.orders, pairedOrder(order, value.clientId)),
          pairingHistory: [...state.imports.pairingHistory, change],
        };
        const entityIds = [order.id];
        if (value.approveCustomerLink === true) {
          if (order.externalCustomerId === undefined) {
            return yield* invalid('Objednávka nemá ID zákazníka ze zdroje, vazbu nelze schválit');
          }
          const current = imports.customerLinks.find(
            (link) => link.source === order.source && link.externalCustomerId === order.externalCustomerId,
          );
          if (current !== undefined && current.clientId !== value.clientId) {
            return yield* conflict('Pro toto ID zákazníka už existuje schválená vazba na jiného klienta');
          }
          if (current === undefined) {
            const link = newLink(context, value.clientId, order.source, order.externalCustomerId, state);
            const linked = applyLink(
              { ...imports, customerLinks: [...imports.customerLinks, link] },
              link,
              context,
              order.id,
            );
            imports = linked.imports;
            entityIds.push(...linked.paired.map((entry) => entry.orderId));
          }
        }
        return { entityIds, state: withImports(state, imports) };
      }),
    ),
    Match.tag('UnpairOrder', (value) =>
      Effect.gen(function* unpairOrder() {
        yield* requireWriteAll(context);
        const order = yield* findOrder(state, value.orderId);
        if (order.clientId === undefined) {
          return yield* conflict('Objednávka není napárovaná');
        }
        const { clientId, ...rest } = order;
        const change: PairingChange = {
          at: context.now,
          by: context.viewer.principalId,
          fromClientId: clientId,
          id: newId(context, 'pairing'),
          orderId: order.id,
          reason: value.reason,
          via: 'manual',
        };
        return {
          entityIds: [order.id],
          state: withImports(state, {
            ...state.imports,
            orders: replaceOrder(state.imports.orders, { ...rest, pairing: 'unpaired' }),
            pairingHistory: [...state.imports.pairingHistory, change],
          }),
        };
      }),
    ),
    Match.tag('ResolveOrderStatusEvent', (value) =>
      Effect.gen(function* resolveOrderStatusEvent() {
        yield* requireWriteAll(context);
        const order = yield* findOrder(state, value.orderId);
        const event = order.statusHistory[value.eventIndex];
        if (event === undefined || event.review !== true) {
          return yield* notFound('Událost ke kontrole neexistuje');
        }
        if (event.resolution !== undefined) {
          return yield* conflict('O této události už bylo rozhodnuto');
        }
        const resolution = {
          at: context.now,
          by: context.viewer.principalId,
          decision: value.decision === 'apply' ? ('applied' as const) : ('dismissed' as const),
          reason: value.reason,
        };
        const statusHistory = order.statusHistory.map((entry, index) =>
          index === value.eventIndex ? { ...entry, resolution } : entry,
        );
        const next: ImportedOrder =
          value.decision === 'apply'
            ? { ...order, rawStatus: event.rawStatus, statusHistory }
            : { ...order, statusHistory };
        return {
          entityIds: [order.id],
          state: withImports(state, { ...state.imports, orders: replaceOrder(state.imports.orders, next) }),
        };
      }),
    ),
    Match.tag('ResolveOrderDuplicate', (value) =>
      Effect.gen(function* resolveOrderDuplicate() {
        yield* requireWriteAll(context);
        const order = yield* findOrder(state, value.orderId);
        if (order.duplicateOf === undefined || (order.decisions ?? []).length > 0) {
          return yield* conflict('Objednávka nečeká na rozhodnutí o duplicitě');
        }
        const decision = {
          at: context.now,
          by: context.viewer.principalId,
          decision: value.decision,
          reason: value.reason,
        };
        const { duplicateOf, ...rest } = order;
        const next: ImportedOrder =
          value.decision === 'distinct'
            ? { ...rest, decisions: [decision] }
            : { ...order, decisions: [decision], duplicateOf };
        return {
          entityIds: [order.id],
          state: withImports(state, { ...state.imports, orders: replaceOrder(state.imports.orders, next) }),
        };
      }),
    ),
    Match.exhaustive,
  );
