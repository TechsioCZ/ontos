// Pure view model of the documents page: filters, contract register ordering and upcoming deadlines (S12-01).
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { foldSearchText } from '@app/admin-ui';
import type { ContractStatus, DocumentRecord } from '../../../../../../shared/domain/documents.ts';
import { documentLinks } from '../../../../../../shared/domain/documents.ts';
import { daysUntil } from '../../../../../ui/documents-kit.tsx';

const statusVariant: Readonly<Record<ContractStatus, 'outline' | 'success' | 'warning' | 'danger'>> = {
  active: 'success',
  draft: 'outline',
  expired: 'danger',
  terminated: 'warning',
};

export const ContractStatusBadge = ({ status }: { readonly status: ContractStatus }) => {
  const { t } = useModernI18n();
  return (
    <Badge size="sm" variant={statusVariant[status]}>
      {t(`siampark-ops.documents.contractStatus.${status}`)}
    </Badge>
  );
};

export const isContractDocument = (document: DocumentRecord) =>
  document.category === 'contract' || document.category === 'amendment' || document.contract !== undefined;

export interface DocumentFilter {
  readonly query: string;
  readonly category: string;
  /** `<kind>:<id>` of a linked record, or '' for all. */
  readonly link: string;
}

export const matchesFilter = (document: DocumentRecord, filter: DocumentFilter) => {
  const links = documentLinks(document);
  if (filter.category !== '' && document.category !== filter.category) {
    return false;
  }
  if (filter.link !== '' && !links.some((link) => `${link.kind}:${link.id}` === filter.link)) {
    return false;
  }
  const query = foldSearchText(filter.query.trim());
  if (query === '') {
    return true;
  }
  const haystack = foldSearchText(
    [
      document.title,
      document.description ?? '',
      ...links.map((link) => link.label),
      ...(document.contract?.parties ?? []),
      document.contract?.subject ?? '',
      ...document.versions.map((version) => version.file.name),
    ].join(' '),
  );
  return haystack.includes(query);
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

export const deadlineVariant = (days: number) => {
  if (days <= 7) {
    return 'danger' as const;
  }
  return days <= 30 ? ('warning' as const) : ('info' as const);
};
