// AREA: imports (C03, C04) — owned by the crm-imports lane.
// Pure import engine: applies parsed CSV rows to the imports slice. Used by the ImportOrdersCsv reducer (server,
// authoritative) and by the browser preview (same rules, nothing saved).
//
// Rules (CRM spec C03/C04):
//  - an order is identified by source + external id; a later row for it adds a status event, never a second order;
//  - an identical event (same event id, or same raw status + event time) is a duplicate and changes nothing;
//  - an event older than the last applied one, without an event time, or a different status at the same time is
//    kept in the history, flagged "vyžaduje kontrolu" and NOT applied;
//  - a new order is paired only through an approved external customer link; IČO / e-mail / name matches are only
//    candidates for manual pairing (never applied automatically);
//  - the same order number from another source is a suspected duplicate: kept, flagged, out of confirmed totals.
import type { ClientsSlice } from '../domain/clients.ts';
import type {
  ImportBatch,
  ImportRowResult,
  ImportedOrder,
  ImportsSlice,
  OrderStatusEvent,
  PairingCandidate,
  PairingChange,
} from '../domain/imports.ts';
import { linkTargetClientId } from '../domain/imports.ts';
import { ORDERS_CSV_FORMAT } from './csv.ts';
import type { ParsedCsv, ParsedOrderRow } from './csv.ts';

export interface ImportMeta {
  readonly batchId: string;
  readonly fileName: string;
  readonly now: string;
  readonly by: string;
  /** Deterministic id of the n-th entity created by this import. */
  readonly newId: (suffix: string) => string;
}

export interface ImportResult {
  readonly slice: ImportsSlice;
  readonly batch: ImportBatch;
  readonly touchedOrderIds: readonly string[];
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
  order: { readonly customerRegNo?: string; readonly customerEmail?: string; readonly customerName?: string },
): PairingCandidate[] => {
  const found = new Map<string, string[]>();
  const add = (clientId: string, reason: string) => {
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
      left.eventAt === right.eventAt
    : left.rawStatus === right.rawStatus && left.eventAt === right.eventAt;

const orderKey = (source: string, externalId: string) => `${source}\u0000${externalId}`;

const definedEntries = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };

const pragueTime = new Intl.DateTimeFormat('cs-CZ', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Prague',
});
/** Readable Prague time for review reasons stored with the order. */
const formatFor = (value: string | undefined) => {
  if (value === undefined) {
    return 'bez času';
  }
  const epoch = Date.parse(value);
  return Number.isNaN(epoch) ? value : pragueTime.format(epoch);
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
  const touched = new Set<string>();
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
    const twin =
      row.number === undefined
        ? undefined
        : [...orders.values()].find(
            (order) => order.source !== row.source && order.number === row.number && order.duplicateOf === undefined,
          );
    const candidates = link === undefined ? pairingCandidates(clients, row) : [];
    const order: ImportedOrder = {
      externalId: row.externalId,
      id,
      pairing: link === undefined ? (candidates.length > 0 ? 'review' : 'unpaired') : 'paired',
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
        reviewReason:
          twin === undefined
            ? undefined
            : `Stejné číslo objednávky ${row.number ?? ''} už přišlo ze zdroje ${twin.source}. Bez potvrzené korelace se nezapočítává do potvrzených souhrnů.`,
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
        reason: `Schválená vazba zákaznického ID ${link.externalCustomerId} (${link.source})`,
        toClientId: linkTargetClientId(clients.items, link),
        via: 'customer_link',
      });
    }
    if (twin !== undefined) {
      return { outcome: 'review' as const, message: order.reviewReason ?? '', orderId: id };
    }
    return {
      message:
        link === undefined
          ? candidates.length > 0
            ? 'Nová objednávka, klient nejistý: k ruční kontrole v párování'
            : 'Nová objednávka od neznámého zákazníka: čeká na napárování'
          : `Nová objednávka, napárováno na ${clientName(linkTargetClientId(clients.items, link))}`,
      orderId: id,
      outcome: 'created' as const,
    };
  };

  const updateOrder = (existing: ImportedOrder, row: ParsedOrderRow, event: OrderStatusEvent) => {
    if (existing.statusHistory.some((entry) => sameEvent(entry, event))) {
      return {
        message: 'Stejná událost už byla importována, nic se nezměnilo',
        orderId: existing.id,
        outcome: 'duplicate' as const,
      };
    }
    const last = existing.lastEventAt;
    const conflictingEventId =
      event.eventId !== undefined &&
      existing.statusHistory.some((entry) => entry.eventId === event.eventId && entry.source === event.source);
    const reviewReason = conflictingEventId
      ? 'Stejné ID události už přišlo s jiným stavem nebo časem, zdrojová data jsou sporná'
      : event.eventAt === undefined
        ? 'Chybí čas události, pořadí změn nelze ověřit'
        : last === undefined
          ? 'Předchozí stav nemá čas události, pořadí změn nelze bezpečně ověřit'
          : event.eventAt < last
            ? `Událost je starší než poslední známý stav „${existing.rawStatus}“ (${formatFor(last)}), nepřepisuje ho`
            : last !== undefined && event.eventAt === last && event.rawStatus !== existing.rawStatus
              ? `Ve stejném čase už je stav „${existing.rawStatus}“, nový stav je sporný`
              : undefined;
    const filled = definedEntries({
      amount: existing.amount ?? row.amount,
      currency: existing.currency ?? row.currency,
      customerEmail: existing.customerEmail ?? row.customerEmail,
      customerName: existing.customerName ?? row.customerName,
      customerRegNo: existing.customerRegNo ?? row.customerRegNo,
      externalCustomerId: existing.externalCustomerId ?? row.externalCustomerId,
      lines: existing.lines ?? row.lines,
      number: existing.number ?? row.number,
      orderedAt: existing.orderedAt ?? row.orderedAt,
    });
    const next: ImportedOrder =
      reviewReason === undefined
        ? {
            ...existing,
            ...filled,
            lastEventAt: event.eventAt ?? existing.lastEventAt ?? meta.now,
            rawStatus: event.rawStatus,
            statusHistory: [...existing.statusHistory, event],
          }
        : {
            ...existing,
            ...filled,
            statusHistory: [...existing.statusHistory, { ...event, review: true, reviewReason }],
          };
    orders.set(orderKey(existing.source, existing.externalId), next);
    touched.add(existing.id);
    return reviewReason === undefined
      ? {
          message: `Stav ${existing.rawStatus} → ${event.rawStatus}`,
          orderId: existing.id,
          outcome: 'updated' as const,
        }
      : { message: `Vyžaduje kontrolu: ${reviewReason}`, orderId: existing.id, outcome: 'review' as const };
  };

  for (const parsedRow of parsed.rows) {
    if (parsedRow.kind === 'error') {
      results.push({
        message: parsedRow.message,
        outcome: 'error',
        row: parsedRow.row,
        ...(parsedRow.externalId === undefined ? {} : { externalId: parsedRow.externalId }),
      });
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
  const batch: ImportBatch = {
    accepted,
    created,
    duplicates,
    errors: [
      ...(parsed.fileError === undefined ? [] : [{ message: parsed.fileError, row: 1 }]),
      ...results
        .filter((result) => result.outcome === 'error')
        .map((result) => ({ message: result.message, row: result.row })),
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
    source: sources.length === 0 ? 'neuvedeno' : sources.join(', '),
    status: rejected === 0 ? 'completed' : accepted + duplicates === 0 ? 'failed' : 'completed_with_errors',
    unpaired,
    updated: count('updated'),
    ...(parsed.unknownColumns.length === 0 ? {} : { unknownColumns: parsed.unknownColumns }),
  };
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
