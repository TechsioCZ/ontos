// Shared CRM UI helpers (owned by crm-scaffold): load-state gate, scope note, Czech table labels.
import { EmptyState, PageHeader, dataTableRowLabels, paginationTranslations } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import type { DataTableTranslations } from '@techsio/ui-kit/organisms/data-table';
import type { ReactNode } from 'react';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { canSeeEverything } from '../../shared/domain/access.ts';
import type { CrmRecordsState } from './records.ts';

/** Renders children only with loaded records; loading / error / forbidden states otherwise. */
export const CrmStateGate = ({
  children,
  loadingTitle,
  onRetry,
  state,
}: {
  readonly children: (records: RecordsResponse) => ReactNode;
  readonly loadingTitle?: string;
  readonly onRetry: () => void;
  readonly state: CrmRecordsState;
}) => {
  const { t } = useModernI18n();
  if (state.kind === 'loading') {
    return (
      <div aria-busy="true" className="flex min-w-0 flex-col gap-250">
        {loadingTitle !== undefined && <PageHeader title={loadingTitle} />}
        <StatusText status="default">{t('crm.common.loading')}</StatusText>
        {loadingTitle !== undefined && (
          <div
            aria-hidden="true"
            className="flex flex-col gap-150 rounded-lg border border-border-primary bg-surface p-250"
          >
            {[0, 1, 2, 3, 4].map((row) => (
              <div className="h-500 animate-pulse rounded-md bg-surface-secondary" key={row} />
            ))}
          </div>
        )}
      </div>
    );
  }
  if (state.kind === 'forbidden') {
    return <EmptyState title={t('crm.common.forbiddenTitle')} />;
  }
  if (state.kind === 'error') {
    return (
      <EmptyState
        action={
          <Button onClick={onRetry} size="sm" theme="outlined" variant="secondary">
            {t('crm.common.retry')}
          </Button>
        }
        description={t('crm.common.errorDescription')}
        title={t('crm.common.errorTitle')}
      />
    );
  }
  return <>{children(state.records)}</>;
};

/** "You see all clients" vs "only your clients" — makes the server-side ACL visible in the demo. */
export const CrmScopeNote = ({ records }: { readonly records: RecordsResponse }) => {
  const { t } = useModernI18n();
  const all = canSeeEverything(records.viewer);
  const key = all
    ? 'crm.common.scopeAll'
    : records.state.clients.items.length === 0
      ? 'crm.common.scopeNone'
      : 'crm.common.scopeAssigned';
  return (
    <p className="inline-flex w-fit items-center gap-100 rounded-full border border-border-primary bg-surface px-150 py-50 text-fg-secondary text-xs">
      <span
        aria-hidden
        className={all ? 'icon-[mdi--account-group-outline] size-200' : 'icon-[mdi--shield-account-outline] size-200'}
      />
      {t(key)}
    </p>
  );
};

export const crmTableTranslations: DataTableTranslations = {
  ...dataTableRowLabels,
  actionsLabel: 'Akce',
  clearSearchLabel: 'Vymazat hledání',
  columnsLabel: 'Sloupce',
  editingLabel: 'Úpravy',
  emptyDescription: 'Žádné záznamy neodpovídají.',
  emptyTitle: 'Žádné záznamy',
  filtersLabel: 'Filtry',
  loadingLabel: 'Načítání…',
  pageSizeLabel: 'Počet na stránku',
  rangeLabel: ({ end, start, total }) => `${start}–${end} z ${total}`,
  requiredLabel: 'Povinné',
  searchButtonLabel: 'Hledat',
  searchLabel: 'Hledat',
  searchPlaceholder: 'Hledat…',
  selectAllLabel: 'Vybrat vše',
  selectionLabel: 'Výběr',
};

export const crmPaginationProps = { translations: paginationTranslations };
