import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { BulkActionBar, EmptyState, PageHeader, StatCard, StatRow, formatDate, formatNumber } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Toaster } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { CellContext, ColumnDef, DataTableTranslations } from '@techsio/ui-kit/organisms/data-table';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { BulkTagDialog, TagCell, TagFilter } from '@app/tagging/components/tag-controls';
import { Effect, Predicate } from 'effect';
import { useEffect, useState } from 'react';

import '../../../index.css';

import { partyRegistryI18nResources } from '../../../../i18n/resources.ts';
import type { CustomerListItem } from '../../../../api/customers-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { CustomerBulkEditDialog } from './customer-bulk-edit-dialog.tsx';
import { CustomerCreateDialog } from './customer-create-dialog.tsx';
import { CustomerDetailDialog } from './customer-detail-dialog.tsx';
import { loadCustomers } from './customers-data.ts';
import type { CustomersSnapshot } from './customers-data.ts';
import { buildCustomersCsv, computeCustomerStats, matchesCustomerSearch, orDash } from './customers-model.ts';
import { subjectIdOf, useCustomerEnrichment } from './use-customer-enrichment.ts';

const key = 'party-registry.pages.customers';
const pageSizeOptions = [50, 100, 200];
const pinning = { end: [], start: ['displayName'] };
/** Phone and DIČ stay in the column menu; the segment column is visible until its lookup fails. */
const defaultColumnVisibility = { phone: false, vatId: false } satisfies ColumnVisibility;

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'forbidden' }
  | { readonly data: CustomersSnapshot; readonly status: 'ready' };

/** Row selection as the ui-kit DataTable types it: selected row ids only. */
type Selection = Record<string, true>;

/** Column visibility as the ui-kit DataTable types it: column id to shown. */
type ColumnVisibility = Record<string, boolean>;

/** Reads every customer, archived included, so the stat tiles describe the whole register. */
const loadCustomersInto = (onLoaded: (state: LoadState) => void): void => {
  void browserRuntime.runPromise(
    loadCustomers.pipe(
      Effect.match({
        onFailure: (error): LoadState =>
          Predicate.isTagged(error, 'CustomerListForbiddenProblem') ? { status: 'forbidden' } : { status: 'error' },
        onSuccess: (data): LoadState => ({ data, status: 'ready' }),
      }),
      Effect.map(onLoaded),
    ),
  );
};

const nameCell = (info: CellContext<CustomerListItem>) => (
  <span className="block truncate font-medium">{orDash(info.row.original.displayName)}</span>
);
const textCell = (info: CellContext<CustomerListItem>) => (
  <span className="block truncate">{orDash(info.getValue<string | null>())}</span>
);
const dateCell = (info: CellContext<CustomerListItem>) => formatDate(info.row.original.createdAt);
const statusCell = (info: CellContext<CustomerListItem>) => (
  <Badge size="sm" variant={info.row.original.status === 'ACTIVE' ? 'success' : 'outline'}>
    {info.getValue<string>()}
  </Badge>
);
const format = (count: number | undefined) => (count === undefined ? '—' : formatNumber(count));

const downloadCsv = (csv: string) => {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'zakaznici.csv';
  link.click();
  URL.revokeObjectURL(url);
};

const CustomersContent = () => {
  const { t } = useModernI18n();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Selection>({});
  const [detail, setDetail] = useState<CustomerListItem | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibility>(defaultColumnVisibility);
  const [editOpen, setEditOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);

  useEffect(() => {
    loadCustomersInto(setState);
  }, []);

  // Refresh keeps rows on screen; only a failed load replaces them, so an error never reads as "no records".
  const reload = () => loadCustomersInto(setState);
  const retry = () => {
    setState({ status: 'loading' });
    reload();
  };

  const data = state.status === 'ready' ? state.data : undefined;
  const items = data?.items ?? [];
  const enrichment = useCustomerEnrichment(data);
  const { segments, tagFilter, taggedIds, tagsBySubject, tagStatus } = enrichment;

  const visible = items.filter(
    (item) => matchesCustomerSearch(item, search) && (tagFilter === null || (taggedIds?.has(item.partyId) ?? false)),
  );
  const stats = data === undefined ? undefined : computeCustomerStats(data.items, data.nowMillis);
  const selectedItems = items.filter((item) => selection[item.counterpartyId] === true);
  const selectedSubjectIds = selectedItems.map((item) => subjectIdOf(item.partyId));
  const statusLabel = (item: CustomerListItem) => t(`${key}.status.${item.status}`);
  // Segment lookup is best effort: when permissions are missing the column hides without an error banner.
  const effectiveVisibility = enrichment.segmentsFailed ? { ...columnVisibility, segment: false } : columnVisibility;

  const segmentCell = (info: CellContext<CustomerListItem>) => {
    const segment = segments?.get(info.row.original.partyId);
    if (segment !== undefined) {
      return segment.name;
    }
    return segments === null ? '…' : '—';
  };
  const tagsCell = (info: CellContext<CustomerListItem>) => {
    if (tagStatus === 'error') {
      return <span className="text-sm">{t(`${key}.tags.failed`)}</span>;
    }
    return <TagCell tags={tagsBySubject.get(subjectIdOf(info.row.original.partyId)) ?? []} />;
  };

  const columns: ColumnDef<CustomerListItem>[] = [
    { accessorKey: 'displayName', cell: nameCell, header: t(`${key}.columns.name`), meta: { width: 280 } },
    { accessorKey: 'companyId', cell: textCell, header: t(`${key}.columns.companyId`), meta: { width: 110 } },
    { accessorKey: 'vatId', cell: textCell, header: t(`${key}.columns.vatId`), meta: { width: 130 } },
    { accessorKey: 'city', cell: textCell, header: t(`${key}.columns.city`), meta: { width: 140 } },
    { accessorKey: 'email', cell: textCell, header: t(`${key}.columns.email`), meta: { width: 220 } },
    { accessorKey: 'phone', cell: textCell, header: t(`${key}.columns.phone`), meta: { width: 140 } },
    {
      accessorKey: 'createdAt',
      cell: dateCell,
      header: t(`${key}.columns.createdAt`),
      meta: { type: 'date', width: 130 },
    },
    {
      accessorFn: statusLabel,
      cell: statusCell,
      header: t(`${key}.columns.status`),
      id: 'status',
      meta: { width: 120 },
    },
    {
      cell: segmentCell,
      enableSorting: false,
      header: t(`${key}.columns.segment`),
      id: 'segment',
      meta: { width: 140 },
    },
    { cell: tagsCell, enableSorting: false, header: t(`${key}.columns.tags`), id: 'tags', meta: { width: 200 } },
  ];

  const translations: DataTableTranslations = {
    clearSearchLabel: t(`${key}.table.clearSearchLabel`),
    columnsLabel: t(`${key}.table.columnsLabel`),
    emptyDescription: t(`${key}.table.emptyDescription`),
    emptyTitle: t(`${key}.table.emptyTitle`),
    loadingLabel: t(`${key}.table.loadingLabel`),
    pageSizeLabel: t(`${key}.table.pageSizeLabel`),
    rangeLabel: ({ end, start, total }) => t(`${key}.table.rangeLabel`, { end, start, total }),
    searchButtonLabel: t(`${key}.table.searchButtonLabel`),
    searchLabel: t(`${key}.table.searchLabel`),
    searchPlaceholder: t(`${key}.search.placeholder`),
    selectAllLabel: t(`${key}.table.selectAllLabel`),
    selectionLabel: t(`${key}.table.selectionLabel`),
  };

  const exportSelected = () => {
    const header = ['name', 'companyId', 'vatId', 'city', 'email', 'phone', 'createdAt', 'status'].map((column) =>
      t(`${key}.columns.${column}`),
    );
    const rows = selectedItems.map((item) => [
      orDash(item.displayName),
      orDash(item.companyId),
      orDash(item.vatId),
      orDash(item.city),
      orDash(item.email),
      orDash(item.phone),
      formatDate(item.createdAt),
      statusLabel(item),
    ]);
    downloadCsv(buildCustomersCsv(header, rows));
  };

  const openCreate = () => setCreateOpen(true);
  const closeDetail = (open: boolean) => {
    if (!open) {
      setDetail(null);
    }
  };

  const renderEmpty = () => {
    if (state.status === 'error') {
      return (
        <EmptyState
          action={
            <Button onClick={retry} size="sm" theme="outlined" variant="secondary">
              {t(`${key}.state.retry`)}
            </Button>
          }
          description={t(`${key}.state.loadErrorDescription`)}
          title={t(`${key}.state.loadError`)}
        />
      );
    }
    if (state.status === 'forbidden') {
      return <EmptyState title={t(`${key}.state.forbidden`)} />;
    }
    if (search.trim().length > 0) {
      return (
        <EmptyState
          action={
            <Button onClick={() => setSearch('')} size="sm" theme="outlined" variant="secondary">
              {t(`${key}.state.clearFilters`)}
            </Button>
          }
          title={t(`${key}.state.noResults`)}
        />
      );
    }
    return (
      <EmptyState
        action={
          <Button onClick={openCreate} size="sm" theme="outlined" variant="secondary">
            {t(`${key}.newCustomer`)}
          </Button>
        }
        description={t(`${key}.state.emptyDescription`)}
        title={t(`${key}.state.emptyTitle`)}
      />
    );
  };

  return (
    <>
      <UltramodernRouteHead />
      {/* The shell mounts no Toaster for remotes and ui-kit is not an MF singleton, so this page tree owns one. */}
      <Toaster />
      <div className="flex min-w-0 flex-col gap-250">
        <PageHeader
          actions={
            <Button icon="icon-[mdi--plus]" onClick={openCreate} size="sm" variant="primary">
              {t(`${key}.newCustomer`)}
            </Button>
          }
          description={t(`${key}.description`)}
          title={t(`${key}.title`)}
        />

        <StatRow>
          <StatCard label={t(`${key}.stats.total`)} value={format(stats?.total)} />
          <StatCard label={t(`${key}.stats.newLast30Days`)} value={format(stats?.newLast30Days)} />
          <StatCard label={t(`${key}.stats.withEmail`)} value={format(stats?.withEmail)} />
          <StatCard label={t(`${key}.stats.archived`)} value={format(stats?.archived)} />
        </StatRow>

        <div className="flex flex-wrap items-end gap-200">
          <div className="w-72">
            <TagFilter kind="customer" onChange={enrichment.handleTagFilterChange} value={tagFilter} />
          </div>
          {enrichment.tagFilterFailed && <StatusText status="error">{t(`${key}.tags.filterFailed`)}</StatusText>}
        </div>

        <BulkActionBar onClear={() => setSelection({})} selectedCount={selectedItems.length}>
          <Button
            icon="icon-[mdi--tag-multiple-outline]"
            onClick={() => setTagOpen(true)}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {t(`${key}.bulk.tags`)}
          </Button>
          <Button
            icon="icon-[mdi--square-edit-outline]"
            onClick={() => setEditOpen(true)}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {t(`${key}.bulk.edit`)}
          </Button>
          <Button
            icon="icon-[mdi--file-delimited-outline]"
            onClick={exportSelected}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {t(`${key}.bulk.exportCsv`)}
          </Button>
        </BulkActionBar>

        <DataTable
          columnPinning={pinning}
          columns={columns}
          columnVisibility={effectiveVisibility}
          data={visible}
          enableColumnPinning
          enableColumnVisibility
          enableGlobalFilter
          enablePagination
          enableRowSelection
          enableSorting
          getRowId={(row) => row.counterpartyId}
          getRowLabel={(row) => row.original.displayName ?? row.original.counterpartyId}
          globalFilter={search}
          loading={state.status === 'loading' || enrichment.tagFilterLoading}
          loadingRowCount={12}
          maxHeight="calc(100dvh - 15rem)"
          onColumnVisibilityChange={setColumnVisibility}
          onGlobalFilterChange={setSearch}
          onRowClick={(row) => setDetail(row.original)}
          onRowSelectionChange={setSelection}
          pageSizeOptions={pageSizeOptions}
          renderEmpty={renderEmpty}
          rowSelection={selection}
          size="sm"
          stickyHeader
          tableLayout="fixed"
          translations={translations}
        />
      </div>

      <CustomerCreateDialog onCreated={reload} onOpenChange={setCreateOpen} open={createOpen} />
      <CustomerDetailDialog customer={detail} onOpenChange={closeDetail} onRenamed={reload} />
      <CustomerBulkEditDialog
        items={selectedItems}
        onArchived={reload}
        onChooseTag={() => setTagOpen(true)}
        onOpenChange={setEditOpen}
        open={editOpen}
      />
      <BulkTagDialog
        kind="customer"
        onDone={enrichment.handleTagsChanged}
        onOpenChange={setTagOpen}
        open={tagOpen}
        subjectIds={selectedSubjectIds}
      />
    </>
  );
};

export const CustomersPage = () => (
  <FederatedI18nBoundary
    defaultNamespace="party-registry"
    fallbackLanguage="en"
    resources={partyRegistryI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <CustomersContent />
  </FederatedI18nBoundary>
);

export default CustomersPage;
