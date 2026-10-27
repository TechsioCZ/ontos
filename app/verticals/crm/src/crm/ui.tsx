// Shared CRM UI helpers (owned by crm-scaffold): load-state gate, scope note, Czech table labels.
import {
  EmptyState,
  PageHeader,
  dataTableRowLabels,
  paginationTranslations,
  surfaceTileClassName,
} from '@app/admin-ui';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Option, Schema } from 'effect';
import { CrmQueryStringSchema } from '../../shared/route-search.ts';
import type { CrmRouteSearch } from '../../shared/route-search.ts';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import type { DataTableTranslations } from '@techsio/ui-kit/organisms/data-table';
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { canSeeEverything } from '../../shared/domain/access.ts';
import type { CrmRecordsState } from './records.ts';
import './loading-skeleton.css';

/** Decode the provider's original query string, preserving opaque IDs that resemble JSON. */
export const useCrmRouteSearch = (): CrmRouteSearch => {
  const query = useRouterState({ select: (state) => state.location.searchStr });
  return Option.getOrElse(Schema.decodeOption(CrmQueryStringSchema)(query), (): CrmRouteSearch => ({}));
};

/** A local selection applies only to the router location where the user made it. */
export const useCrmRouteSelection = (key: keyof Pick<CrmRouteSearch, 'klient' | 'objednavka'>) => {
  const location = useRouterState({
    select: (state) => ({
      href: state.location.href,
      key: state.location.state.__TSR_key,
      searchStr: state.location.searchStr,
    }),
  });
  const search = Option.getOrElse(
    Schema.decodeOption(CrmQueryStringSchema)(location.searchStr),
    (): CrmRouteSearch => ({}),
  );
  const [selection, setSelection] = useState({ id: search[key], location });
  const selected =
    selection.location.href === location.href && selection.location.key === location.key ? selection.id : search[key];
  const select = (id: string | undefined) => setSelection({ id, location });
  return [selected, select] as const;
};

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
    // Only reached on a cold mount the Shell could not prepare: one quiet skeleton, no loading text chain.
    return (
      <div aria-busy="true" className="flex min-w-0 flex-col gap-250">
        <span className="sr-only">{t('crm.common.loading')}</span>
        {loadingTitle !== undefined && <PageHeader title={loadingTitle} />}
        <div aria-hidden="true" className={`${surfaceTileClassName} flex flex-col gap-150 p-250`}>
          {[0, 1, 2, 3, 4].map((row) => (
            <div className="crm-loading-skeleton-row" key={row} />
          ))}
        </div>
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
  let key = 'crm.common.scopeAssigned';
  if (all) {
    key = 'crm.common.scopeAll';
  } else if (records.state.clients.items.length === 0) {
    key = 'crm.common.scopeNone';
  }
  return (
    <p className="inline-flex w-fit items-center gap-100 rounded-full bg-surface px-150 py-50 text-fg-secondary text-xs">
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
