import { pipe, DateTime, Schema } from 'effect';
import { orderDateText, isOpenDuplicate, needsReview, openReviewEvents } from '../../../../../shared/domain/imports.ts';
import type { ImportRowOutcome, ImportedOrder } from '../../../../../shared/domain/imports.ts';
// AREA: imports — owned by the crm-imports lane. Display helpers shared by /crm/importy, /crm/parovani and the
// client-card "Objednávky" tab.

import { useCrmMoneyFormats } from '../../../../crm/number-formats.tsx';
import { formatDate, formatDateTime } from '@app/admin-ui';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';

import { orderStatusLabel, statusReviewReasonLabel } from '../../../../crm/order-status-presentation.ts';

export const RESIZE_LABEL = 'Změnit šířku panelu (šipky vlevo a vpravo)';
export const NOT_PROVIDED = 'údaj neposkytnut';

// Read-only source rows have no governed item ID. Content plus its duplicate occurrence is a display key only.
const displayContentKey = (parts: readonly (string | undefined)[]) =>
  parts.map((part) => (part === undefined ? 'u' : `${String(part.length)}:${part}`)).join('|');

const displayOccurrences = <A>(rows: readonly A[], contentOf: (row: A) => string) => {
  const occurrences = new Map<string, number>();
  return rows.map((row) => {
    const content = contentOf(row);
    const occurrence = occurrences.get(content) ?? 0;
    occurrences.set(content, occurrence + 1);
    return { key: `${String(content.length)}:${content}:${String(occurrence)}`, row };
  });
};

export const orderLineDisplayRows = (lines: NonNullable<ImportedOrder['lines']>) =>
  displayOccurrences(lines, (line) =>
    displayContentKey([line.externalId, line.sku, line.name, line.quantity, line.amount]),
  );

export const orderStatusDisplayRows = (events: ImportedOrder['statusHistory']) =>
  displayOccurrences(events, (event) =>
    displayContentKey([
      event.batchId,
      event.eventId,
      event.eventAt === undefined ? undefined : DateTime.formatIso(event.eventAt),
      DateTime.formatIso(event.importedAt),
      event.rawStatus,
      event.review === undefined ? undefined : String(event.review),
      event.reviewReason,
      event.row === undefined ? undefined : String(event.row),
      event.source,
      event.resolution === undefined
        ? undefined
        : displayContentKey([
            DateTime.formatIso(event.resolution.at),
            event.resolution.by,
            event.resolution.decision,
            event.resolution.reason,
          ]),
    ]),
  );

/** Czech row count used on the import confirmation, including one-row status changes. */
export const importRowsLabel = (count: number): string => {
  let word = 'řádků';
  if (count === 1) {
    word = 'řádek';
  } else if (count >= 2 && count <= 4) {
    word = 'řádky';
  }
  return `Importovat ${String(count)} ${word}`;
};

/** Fixed demo personas without a salesperson record (principal ids from scripts/demo/fixture-ids.mts). */
const knownPrincipals = new Map(
  Object.entries({
    '443f7f2a-47ac-5494-982b-366b0ecefd88': 'Jan Novák',
    '849fdb3c-fab6-5c14-b20a-d885dc27313d': 'Správce CRM',
    '8abb7df7-c19d-5d49-836a-2146dbe5064c': 'Vedoucí obchodu',
    'ce3d8eaa-1d5d-5f71-979f-9c06fd28a7f1': 'Petra Svobodová',
  }),
);

/** Who did it, readable. */
export const principalLabel = (records: RecordsResponse, principalId: string): string => {
  const person = records.state.salespeople.find((entry) => entry.principalId === principalId);
  const name = person?.name ?? knownPrincipals.get(principalId);
  if (principalId === records.viewer.principalId) {
    return name === undefined ? 'Vy' : `${name} (vy)`;
  }
  return name ?? `Uživatel ${principalId.slice(0, 8)}`;
};

export const clientLabel = (records: RecordsResponse, clientId: string | undefined) =>
  clientId === undefined
    ? undefined
    : (records.state.clients.items.find((client) => client.id === clientId)?.name ?? 'Klient mimo váš přístup');

/** Display adapter; formatter instances belong to the enclosing CRM page. */
export const useFormatAmount = () => {
  const { formatImportCurrency } = useCrmMoneyFormats();
  return (amount: string | undefined, currency: string | undefined): string => {
    if (amount === undefined || currency === undefined) {
      return NOT_PROVIDED;
    }
    return formatImportCurrency(Number(amount), currency);
  };
};

export const orderTitle = (order: ImportedOrder) => order.number ?? order.externalId;
export const orderDate = (order: ImportedOrder) =>
  order.orderedAt === undefined ? NOT_PROVIDED : pipe(order.orderedAt, orderDateText, formatDate);
export const lastChange = (order: ImportedOrder) =>
  pipe(order.lastEventAt ?? order.receivedAt, orderDateText, formatDateTime);

export const OrderQueueStateSchema = Schema.Literals(['paired', 'unpaired', 'uncertain']);
export type OrderQueueState = typeof OrderQueueStateSchema.Type;
export const orderQueueState = (order: ImportedOrder): OrderQueueState => {
  if (order.pairing === 'paired') {
    return 'paired';
  }
  return order.pairing === 'review' ? 'uncertain' : 'unpaired';
};

export const pairingMeta = {
  paired: { label: 'Napárováno', variant: 'success' },
  uncertain: { label: 'Nejistý klient', variant: 'warning' },
  unpaired: { label: 'Nenapárováno', variant: 'danger' },
} satisfies Record<OrderQueueState, { label: string; variant: 'success' | 'warning' | 'danger' }>;

export const outcomeMeta = {
  created: { label: 'Nová objednávka', variant: 'success' },
  duplicate: { label: 'Duplicita – beze změny', variant: 'outline' },
  error: { label: 'Chyba', variant: 'danger' },
  review: { label: 'Vyžaduje kontrolu', variant: 'warning' },
  updated: { label: 'Změna stavu', variant: 'info' },
} satisfies Record<ImportRowOutcome, { label: string; variant: 'success' | 'info' | 'outline' | 'warning' | 'danger' }>;

export const batchStatusMeta = {
  completed: { label: 'Dokončeno', variant: 'success' },
  completed_with_errors: { label: 'Dokončeno s chybami', variant: 'warning' },
  failed: { label: 'Neúspěšné', variant: 'danger' },
} as const;

/** One-line reason why an order needs review. */
export const reviewSummary = (order: ImportedOrder): string | undefined => {
  if (isOpenDuplicate(order)) {
    return order.reviewReason ?? 'Možná duplicita z jiného zdroje';
  }
  const [open] = openReviewEvents(order);
  return open === undefined
    ? undefined
    : `Stav „${orderStatusLabel(open.event.rawStatus)}“: ${statusReviewReasonLabel(open.event.reviewReason ?? 'sporné pořadí')}`;
};

export const reviewCount = (orders: readonly ImportedOrder[]) => orders.filter(needsReview).length;
export const sourcesOf = (orders: readonly ImportedOrder[]) =>
  [...new Set(orders.map((order) => order.source))].toSorted();

export const orderSearchText = (records: RecordsResponse, order: ImportedOrder) =>
  [
    order.number,
    order.externalId,
    order.source,
    order.customerName,
    order.externalCustomerId,
    order.customerRegNo,
    order.customerEmail,
    order.rawStatus,
    orderStatusLabel(order.rawStatus),
    clientLabel(records, order.clientId),
  ]
    .filter((value) => value !== undefined)
    .join(' ');

/** Triggers a browser download of text content (CSV in UTF-8 with BOM so Excel shows diacritics). */
export const downloadText = (fileName: string, text: string) => {
  const anchor = globalThis.document.createElement('a');
  const encoded = encodeURIComponent(`\uFEFF${text}`);
  anchor.href = `data:text/csv;charset=utf-8,${encoded}`;
  anchor.download = fileName;
  globalThis.document.body.append(anchor);
  anchor.click();
  anchor.remove();
};
