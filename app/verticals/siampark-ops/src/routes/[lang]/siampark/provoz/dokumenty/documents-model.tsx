// Pure view model of the documents page: filters, contract register ordering and upcoming deadlines (S12-01).
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { foldSearchText } from '@app/admin-ui';
import type { ContractStatus, DocumentRecord } from '../../../../../../shared/domain/documents.ts';
import { documentLinks } from '../../../../../../shared/domain/documents.ts';

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

export { contractRegister, isContractDocument, upcomingDeadlines } from '../../../../../../shared/domain/documents-deadlines.ts';
export type { Deadline } from '../../../../../../shared/domain/documents-deadlines.ts';

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

export const deadlineVariant = (days: number) => {
  if (days <= 7) {
    return 'danger' as const;
  }
  return days <= 30 ? ('warning' as const) : ('info' as const);
};
