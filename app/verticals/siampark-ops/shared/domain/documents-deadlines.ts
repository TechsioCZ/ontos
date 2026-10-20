// Pure contract-register and deadline computations of the documents agenda (S12-01). OWNED BY THE documents LANE.
import type { DocumentRecord } from './documents.ts';

export const isContractDocument = (document: DocumentRecord) =>
  document.category === 'contract' || document.category === 'amendment' || document.contract !== undefined;

/** Whole days from `today` to an ISO date (`YYYY-MM-DD`); negative when in the past. */
export const daysUntil = (isoDate: string, today: string) => {
  const target = Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10)));
  const base = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
  return Math.round((target - base) / 86_400_000);
};

/** Contracts first by end date (soonest first), each followed by its amendments. */
export const contractRegister = (documents: readonly DocumentRecord[]) => {
  const originals = documents
    .filter((document) => isContractDocument(document) && document.amendsDocumentId === undefined)
    .toSorted((left, right) =>
      (left.contract?.validTo ?? '9999-12-31').localeCompare(right.contract?.validTo ?? '9999-12-31'),
    );
  const rows: { readonly document: DocumentRecord; readonly depth: 0 | 1 }[] = [];
  for (const original of originals) {
    rows.push({ depth: 0, document: original });
    for (const amendment of documents.filter((entry) => entry.amendsDocumentId === original.id)) {
      rows.push({ depth: 1, document: amendment });
    }
  }
  const placed = new Set(rows.map((row) => row.document.id));
  for (const orphan of documents.filter((document) => isContractDocument(document) && !placed.has(document.id))) {
    rows.push({ depth: 1, document: orphan });
  }
  return rows;
};

export interface Deadline {
  readonly document: DocumentRecord;
  readonly kind: 'end' | 'notice';
  readonly date: string;
  readonly days: number;
}

/** Contract ends and notice deadlines from `today - 7` to `today + horizon` days, nearest first. */
export const upcomingDeadlines = (documents: readonly DocumentRecord[], today: string, horizon = 90): Deadline[] =>
  documents
    .flatMap((document): Deadline[] => {
      const contract = document.contract;
      if (contract === undefined || contract.status === 'terminated' || contract.status === 'expired') {
        return [];
      }
      const entries: Deadline[] = [];
      if (contract.validTo !== undefined) {
        entries.push({ date: contract.validTo, days: daysUntil(contract.validTo, today), document, kind: 'end' });
      }
      if (contract.noticeDate !== undefined) {
        entries.push({ date: contract.noticeDate, days: daysUntil(contract.noticeDate, today), document, kind: 'notice' });
      }
      return entries;
    })
    .filter((entry) => entry.days >= -7 && entry.days <= horizon)
    .toSorted((left, right) => left.days - right.days);

