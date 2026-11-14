import { DateTime, Schema } from 'effect';
import csImports from '../../locales/cs/crm-imports.json';
import { ShortTextSchema } from '../domain/common.ts';
import type { EntityId, PrincipalId } from '../domain/common.ts';
// AREA: imports (C03, C04) — owned by the crm-imports lane.
// Pure import engine: applies parsed CSV rows to the imports slice. Used by the ImportOrdersCsv reducer (server,
// authoritative) and by the browser preview (same rules, nothing saved).
//
// Rules (CRM spec C03/C04):
//  - an order is identified by source + external id; a later row for it adds a status event, never a second order;
//  - an identical event never adds status history; newly supplied source details may still fill missing fields;
//  - an event older than the last applied one, without an event time, or a different status at the same time is
//    kept in the history, flagged "vyžaduje kontrolu" and NOT applied;
//  - a new order is paired only through an approved external customer link; IČO / e-mail / name matches are only
//    candidates for manual pairing (never applied automatically);
//  - the same order number from another source is a suspected duplicate: kept, flagged, out of confirmed totals.
import type { ClientsSlice } from '../domain/clients.ts';
import { linkTargetClientId } from '../domain/imports.ts';
import type {
  ImportBatch,
  ImportRowResult,
  ImportedOrder,
  ImportsSlice,
  OrderStatusEvent,
  PairingCandidate,
  PairingChange,
} from '../domain/imports.ts';

import { ORDERS_CSV_FORMAT } from './csv.ts';
import type { ParsedCsv, ParsedOrderRow } from './csv.ts';

export interface ImportMeta {
  readonly batchId: EntityId;
  readonly by: PrincipalId;
  readonly fileName: string;
  /** Deterministic id of the n-th entity created by this import. */
  readonly newId: (suffix: string) => EntityId;
  readonly now: DateTime.Utc;
}

export interface ImportResult {
  readonly batch: ImportBatch;
  readonly slice: ImportsSlice;
  readonly touchedOrderIds: readonly EntityId[];
}

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, ' ')
    .trim();

/** Possible clients for an order without an approved link. Shown for manual pairing only. */
export const pairingCandidates = (
  clients: ClientsSlice,
  order: { readonly customerEmail?: string; readonly customerName?: string; readonly customerRegNo?: string },
): PairingCandidate[] => {
  const found = new Map<EntityId, string[]>();
  const add = (clientId: EntityId, reason: string) => {
    const reasons = found.get(clientId) ?? [];
    if (!reasons.includes(reason)) {
      found.set(clientId, [...reasons, reason]);
    }
  };
  const email = order.customerEmail?.toLowerCase();
  const name = order.customerName === undefined ? undefined : fold(order.customerName);
  for (const client of clients.items) {
    if (client.status !== 'active') {
      continue;
    }
    if (order.customerRegNo !== undefined && client.regNo === order.customerRegNo) {
      add(client.id, 'shoda IČO');
    }
    if (email !== undefined && client.email?.toLowerCase() === email) {
      add(client.id, 'shoda e-mailu');
    }
    if (name !== undefined && name !== '' && fold(client.name) === name) {
      add(client.id, 'shoda názvu');
    }
  }
  if (email !== undefined) {
    for (const contact of clients.contacts) {
      if (contact.email?.toLowerCase() === email) {
        add(contact.clientId, 'shoda e-mailu kontaktní osoby');
      }
    }
  }
  return [...found.entries()].map(([clientId, reasons]) => ({ clientId, reason: reasons.join(', ') }));
};

const sameEvent = (left: OrderStatusEvent, right: OrderStatusEvent) =>
  left.eventId !== undefined && right.eventId !== undefined
    ? left.eventId === right.eventId &&
      left.source === right.source &&
      left.rawStatus === right.rawStatus &&
      (left.eventAt === undefined
        ? right.eventAt === undefined
        : right.eventAt !== undefined && DateTime.Equivalence(left.eventAt, right.eventAt))
    : left.rawStatus === right.rawStatus &&
      (left.eventAt === undefined
        ? right.eventAt === undefined
        : right.eventAt !== undefined && DateTime.Equivalence(left.eventAt, right.eventAt));

const orderKey = (source: string, externalId: string) => `${source}\u0000${externalId}`;

/** Batch display text is bounded; exact source identities remain on every order and status event. */
const summarizeSources = (sources: readonly string[]): string => {
  const summary = sources.length === 0 ? 'neuvedeno' : sources.join(', ');
  if (Schema.is(ShortTextSchema)(summary)) {
    return summary;
  }
  const included: string[] = [];
  for (const source of sources) {
    if (!Schema.is(ShortTextSchema)([...included, source, '…'].join(', '))) {
      break;
    }
    included.push(source);
  }
  return [...included, '…'].join(', ');
};

const definedEntries = <T extends object>(value: T) => {
  const defined: { [K in keyof T]?: Exclude<T[K], undefined> } = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      // Define an own data property, including a literal "__proto__" key, just like Object.fromEntries.
      Object.defineProperty(defined, key, { configurable: true, enumerable: true, value: entry, writable: true });
    }
  }
  return defined;
};

const pragueTime = new Intl.DateTimeFormat('cs-CZ', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Prague',
});
/** Readable Prague time for review reasons stored with the order. */
const formatFor = (value: DateTime.Utc | undefined) => {
  if (value === undefined) {
    return 'bez času';
  }
  return pragueTime.format(DateTime.toEpochMillis(value));
};

/** Refuse to overwrite a source state whose new event cannot be ordered reliably. */
const eventReviewReason = (existing: ImportedOrder, event: OrderStatusEvent): string | undefined => {
  const last = existing.lastEventAt;
  const conflictingEventId =
    event.eventId !== undefined &&
    existing.statusHistory.some((entry) => entry.eventId === event.eventId && entry.source === event.source);
  if (conflictingEventId) {
    return 'Stejné ID události už přišlo s jiným stavem nebo časem, zdrojová data jsou sporná';
  }
  if (event.eventAt === undefined) {
    return 'Chybí čas události, pořadí změn nelze ověřit';
  }
  if (last === undefined) {
    return 'Předchozí stav nemá čas události, pořadí změn nelze bezpečně ověřit';
  }
  if (DateTime.isLessThan(event.eventAt, last)) {
    return `Událost je starší než poslední známý stav „${existing.rawStatus}“ (${formatFor(last)}), nepřepisuje ho`;
  }
  if (DateTime.Equivalence(event.eventAt, last) && event.rawStatus !== existing.rawStatus) {
    return `Ve stejném čase už je stav „${existing.rawStatus}“, nový stav je sporný`;
  }
  return undefined;
};

interface MonetaryEnrichment {
  readonly fields: Partial<Pick<ImportedOrder, 'amount' | 'currency' | 'lines'>>;
  readonly reviewReason?: string;
}

/** An amount is meaningful only in its own snapshot's currency, including amounts on order lines. */
const fillMoney = (existing: ImportedOrder, row: ParsedOrderRow): MonetaryEnrichment => {
  const preserved = definedEntries({
    amount: existing.amount,
    currency: existing.currency,
    lines: existing.lines,
  });
  const existingHasAmount =
    existing.amount !== undefined || existing.lines?.some((line) => line.amount !== undefined) === true;
  if (existing.currency === undefined && existingHasAmount) {
    return { fields: preserved, reviewReason: csImports.imports.incompleteMoney };
  }
  if (existing.currency !== undefined && row.currency !== undefined && existing.currency !== row.currency) {
    return { fields: preserved, reviewReason: csImports.imports.moneyConflict };
  }
  return {
    fields: definedEntries({
      amount: existing.amount ?? row.amount,
      currency: existing.currency ?? row.currency,
      lines: existing.lines ?? row.lines,
    }),
  };
};

const crossSourceTwin = (orders: Iterable<ImportedOrder>, row: ParsedOrderRow) =>
  row.number === undefined
    ? undefined
    : [...orders].find(
        (order) => order.source !== row.source && order.number === row.number && order.duplicateOf === undefined,
      );

const duplicateReason = (twin: ImportedOrder, number: string | undefined) =>
  `Stejné číslo objednávky ${number ?? ''} už přišlo ze zdroje ${twin.source}. Bez potvrzené korelace se nezapočítává do potvrzených souhrnů.`;

const enrichmentFields = [
  'amount',
  'currency',
  'customerEmail',
  'customerName',
  'customerRegNo',
  'externalCustomerId',
  'lines',
  'number',
  'orderedAt',
] as const;

const fillOrderDetails = (existing: ImportedOrder, row: ParsedOrderRow) =>
  definedEntries({
    customerEmail: existing.customerEmail ?? row.customerEmail,
    customerName: existing.customerName ?? row.customerName,
    customerRegNo: existing.customerRegNo ?? row.customerRegNo,
    externalCustomerId: existing.externalCustomerId ?? row.externalCustomerId,
    number: existing.number ?? row.number,
    orderedAt: existing.orderedAt ?? row.orderedAt,
  });

const appendStatusEvent = (
  order: ImportedOrder,
  event: OrderStatusEvent,
  reviewReason: string | undefined,
): ImportedOrder =>
  reviewReason === undefined
    ? {
        ...order,
        lastEventAt: event.eventAt ?? order.lastEventAt ?? event.importedAt,
        rawStatus: event.rawStatus,
        statusHistory: [...order.statusHistory, event],
      }
    : {
        ...order,
        statusHistory: [...order.statusHistory, { ...event, review: true, reviewReason }],
      };

/** Applies parsed rows to the slice. Pure; the caller persists the returned slice. */
export const importOrders = (
  slice: ImportsSlice,
  clients: ClientsSlice,
  parsed: ParsedCsv,
  meta: ImportMeta,
): ImportResult => {
  const orders = new Map<string, ImportedOrder>(
    slice.orders.map((order) => [orderKey(order.source, order.externalId), order]),
  );
  const pairingHistory: PairingChange[] = [...slice.pairingHistory];
  const results: ImportRowResult[] = [];
  const touched = new Set<EntityId>();
  const clientName = (id: string) => clients.items.find((client) => client.id === id)?.name ?? id;
  let created = 0;
  let unpaired = 0;

  const createOrder = (row: ParsedOrderRow, event: OrderStatusEvent) => {
    const id = meta.newId(`o${row.row}`);
    const link =
      row.externalCustomerId === undefined
        ? undefined
        : slice.customerLinks.find(
            (entry) => entry.source === row.source && entry.externalCustomerId === row.externalCustomerId,
          );
    const twin = crossSourceTwin(orders.values(), row);
    const candidates = link === undefined ? pairingCandidates(clients, row) : [];
    let pairing: ImportedOrder['pairing'] = 'paired';
    if (link === undefined) {
      pairing = candidates.length > 0 ? 'review' : 'unpaired';
    }
    const order: ImportedOrder = {
      externalId: row.externalId,
      id,
      pairing,
      rawStatus: row.rawStatus,
      receivedAt: meta.now,
      source: row.source,
      statusHistory: [event],
      ...definedEntries({
        amount: row.amount,
        candidates: candidates.length > 0 ? candidates : undefined,
        clientId: link === undefined ? undefined : linkTargetClientId(clients.items, link),
        currency: row.currency,
        customerEmail: row.customerEmail,
        customerName: row.customerName,
        customerRegNo: row.customerRegNo,
        duplicateOf: twin?.id,
        externalCustomerId: row.externalCustomerId,
        lastEventAt: row.eventAt,
        lines: row.lines,
        number: row.number,
        orderedAt: row.orderedAt,
        reviewReason: twin === undefined ? undefined : duplicateReason(twin, row.number),
      }),
    };
    orders.set(orderKey(row.source, row.externalId), order);
    touched.add(id);
    created += 1;
    if (link === undefined) {
      unpaired += 1;
    } else {
      pairingHistory.push({
        at: meta.now,
        by: meta.by,
        id: meta.newId(`p${row.row}`),
        orderId: id,
        reason: `Schválená vazba zákazníka (${link.source})`,
        toClientId: linkTargetClientId(clients.items, link),
        via: 'customer_link',
      });
    }
    if (twin !== undefined) {
      return { message: order.reviewReason ?? '', orderId: id, outcome: 'review' as const };
    }
    let message: string;
    if (link === undefined) {
      message =
        candidates.length > 0
          ? 'Nová objednávka, klient nejistý: k ruční kontrole v párování'
          : 'Nová objednávka od neznámého zákazníka: čeká na napárování';
    } else {
      message = `Nová objednávka, napárováno na ${clientName(linkTargetClientId(clients.items, link))}`;
    }
    return {
      message,
      orderId: id,
      outcome: 'created' as const,
    };
  };

  const applyNewCustomerLink = (existing: ImportedOrder, row: ParsedOrderRow): ImportedOrder => {
    if (
      existing.externalCustomerId !== undefined ||
      row.externalCustomerId === undefined ||
      existing.clientId !== undefined ||
      existing.pairing === 'paired'
    ) {
      return existing;
    }
    const lastPairing = pairingHistory.findLast((change) => change.orderId === existing.id);
    if (lastPairing?.via === 'manual') {
      return existing;
    }
    const link = slice.customerLinks.find(
      (entry) => entry.source === row.source && entry.externalCustomerId === row.externalCustomerId,
    );
    if (link === undefined) {
      return existing;
    }
    const clientId = linkTargetClientId(clients.items, link);
    pairingHistory.push({
      at: meta.now,
      by: meta.by,
      id: meta.newId(`p${row.row}`),
      orderId: existing.id,
      reason: `Schválená vazba zákazníka (${link.source})`,
      toClientId: clientId,
      via: 'customer_link',
    });
    const { candidates: _candidates, ...rest } = existing;
    return { ...rest, clientId, pairing: 'paired' };
  };

  const updateOrder = (existing: ImportedOrder, row: ParsedOrderRow, event: OrderStatusEvent) => {
    const money = fillMoney(existing, row);
    const repeated = existing.statusHistory.findLast((entry) => sameEvent(entry, event));
    const linked = applyNewCustomerLink(existing, row);
    const twin = existing.number === undefined ? crossSourceTwin(orders.values(), row) : undefined;
    const correlationReason = twin === undefined ? undefined : duplicateReason(twin, row.number);
    const filled = definedEntries({
      ...fillOrderDetails(existing, row),
      ...money.fields,
      duplicateOf: existing.duplicateOf ?? twin?.id,
      reviewReason: correlationReason ?? existing.reviewReason,
    });
    const enriched: ImportedOrder = { ...linked, ...filled };
    const enrichmentChanged = linked !== existing || enrichmentFields.some((key) => enriched[key] !== existing[key]);
    const addEvent =
      repeated === undefined || (money.reviewReason !== undefined && repeated.reviewReason !== money.reviewReason);
    if (!enrichmentChanged && !addEvent) {
      return {
        message: 'Stejná událost už byla importována, nic se nezměnilo',
        orderId: existing.id,
        outcome: 'duplicate' as const,
      };
    }
    const reviewReason =
      money.reviewReason ?? (repeated === undefined ? eventReviewReason(existing, event) : undefined);
    const next = addEvent ? appendStatusEvent(enriched, event, reviewReason) : enriched;
    orders.set(orderKey(existing.source, existing.externalId), next);
    touched.add(existing.id);
    const resultReviewReason = reviewReason ?? correlationReason;
    return resultReviewReason === undefined
      ? {
          message: addEvent ? `Stav ${existing.rawStatus} → ${event.rawStatus}` : csImports.imports.orderEnriched,
          orderId: existing.id,
          outcome: 'updated' as const,
        }
      : { message: `Vyžaduje kontrolu: ${resultReviewReason}`, orderId: existing.id, outcome: 'review' as const };
  };

  for (const parsedRow of parsed.rows) {
    if (parsedRow.kind === 'error') {
      const result: ImportRowResult = {
        message: parsedRow.message,
        outcome: 'error',
        row: parsedRow.row,
      };
      if (parsedRow.externalId !== undefined) {
        Object.assign(result, { externalId: parsedRow.externalId });
      }
      results.push(result);
      continue;
    }
    const row = parsedRow.value;
    const event: OrderStatusEvent = {
      batchId: meta.batchId,
      importedAt: meta.now,
      rawStatus: row.rawStatus,
      row: row.row,
      source: row.source,
      ...definedEntries({ eventAt: row.eventAt, eventId: row.eventId }),
    };
    const existing = orders.get(orderKey(row.source, row.externalId));
    const outcome = existing === undefined ? createOrder(row, event) : updateOrder(existing, row, event);
    results.push({ externalId: row.externalId, row: row.row, ...outcome });
  }

  const count = (outcome: ImportRowResult['outcome']) => results.filter((result) => result.outcome === outcome).length;
  const rejected = count('error') + (parsed.fileError === undefined ? 0 : 1);
  const duplicates = count('duplicate');
  const accepted = count('created') + count('updated') + count('review');
  const sources = [...new Set(parsed.rows.flatMap((row) => (row.kind === 'ok' ? [row.value.source] : [])))];
  let batchStatus: ImportBatch['status'] = 'completed';
  if (rejected !== 0) {
    batchStatus = accepted + duplicates === 0 ? 'failed' : 'completed_with_errors';
  }
  const batch: ImportBatch = {
    accepted,
    created,
    duplicates,
    errors: [
      ...(parsed.fileError === undefined ? [] : [{ message: parsed.fileError, row: 1 }]),
      ...results.flatMap((result) =>
        result.outcome === 'error' ? [{ message: result.message, row: result.row }] : [],
      ),
    ],
    fileName: meta.fileName,
    format: ORDERS_CSV_FORMAT,
    id: meta.batchId,
    importedAt: meta.now,
    importedBy: meta.by,
    rejected,
    results,
    review: count('review'),
    rowCount: parsed.rows.length,
    source: summarizeSources(sources),
    status: batchStatus,
    unpaired,
    updated: count('updated'),
  };
  if (parsed.unknownColumns.length > 0) {
    Object.assign(batch, { unknownColumns: parsed.unknownColumns });
  }
  return {
    batch,
    slice: {
      ...slice,
      batches: [batch, ...slice.batches],
      orders: [...orders.values()],
      pairingHistory,
    },
    touchedOrderIds: [...touched],
  };
};
