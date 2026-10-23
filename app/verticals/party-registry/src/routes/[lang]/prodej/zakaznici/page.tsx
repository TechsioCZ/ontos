import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import {
  BulkActionBar,
  EmptyState,
  PageHeader,
  StatCard,
  StatRow,
  formatDate,
  formatNumber,
  Toaster,
  dataTableRowLabels,
  paginationTranslations,
} from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { CellContext, ColumnDef, DataTableTranslations } from '@techsio/ui-kit/organisms/data-table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { BulkTagDialog, TagCell, TagFilter } from '@app/tagging/components/tag-controls';
import { pageDataPending } from '@app/shared-contracts/page-data';
import { Predicate } from 'effect';
import { useEffect, useState, useSyncExternalStore } from 'react';

import '../../../index.css';

import { partyRegistryI18nResources } from '../../../../i18n/resources.ts';
import type { TagId } from '@app/tagging/contracts/records';
import type { CustomerListItem } from '../../../../api/customers-client.ts';
import { customerSegmentDefinitions } from '../../../../api/customer-segments-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { CustomerBulkEditDialog } from './customer-bulk-edit-dialog.tsx';
import { CustomerCreateDialog } from './customer-create-dialog.tsx';
import { CustomerDetailDialog } from './customer-detail-dialog.tsx';
import {
  allCustomers,
  customerWritesRefused,
  customersData,
  useCustomerDetailSelection,
  rememberCustomerWriteRefusal,
} from './customers-data.ts';
import type { CustomersSnapshot } from './customers-data.ts';
import {
  buildCustomersCsv,
  computeCustomerStats,
  czechCollator,
  matchesCustomerSearch,
  orDash,
} from './customers-model.ts';
import { subjectIdOf, useCustomerEnrichment } from './use-customer-enrichment.ts';

const key = 'party-registry.pages.customers';
const pageSizeOptions = [50, 100, 200];
/** The row-selection column stays first, ahead of the pinned name. */
const pinning = { end: [], start: ['__select', 'displayName'] };
/**
 * DIČ and Stav stay in the column menu; phone shows, because the list is searched by phone. Segment shows by
 * default; when its lookup fails the column is left out entirely, so the column menu never offers a column of dashes.
 */
const defaultColumnVisibility = { status: false, vatId: false } satisfies ColumnVisibility;
const allSegments = 'all';
/** Archived customers stay out of the list until the status filter asks for them. */
const allStatuses = 'all';
const defaultStatusFilter = 'ACTIVE';

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'forbidden' }
  | { readonly data: CustomersSnapshot; readonly status: 'ready' };

/** Row selection as the ui-kit DataTable types it: selected row ids only. */
type Selection = Record<string, true>;

/** Column visibility as the ui-kit DataTable types it: column id to shown. */
type ColumnVisibility = Record<string, boolean>;

type CustomersDataSnapshot = ReturnType<typeof customersData.snapshot>;

/** A failed read that is being retried reads as loading again; a refresh of ready rows keeps them on screen. */
const loadStateOf = (snapshot: CustomersDataSnapshot): LoadState => {
  if (snapshot.state === 'pending' || (snapshot.state === 'failed' && snapshot.refreshing)) {
    return { status: 'loading' };
  }
  if (snapshot.state === 'failed') {
    return Predicate.isTagged(snapshot.error, 'CustomerListForbiddenProblem')
      ? { status: 'forbidden' }
      : { status: 'error' };
  }
  return { data: snapshot.value, status: 'ready' };
};

const serverSnapshot = (): CustomersDataSnapshot => pageDataPending;
const readCustomers = () => customersData.snapshot(allCustomers);
// Refresh keeps rows on screen; only a failed first load shows an error, so an error never reads as "no records".
const reload = () => {
  browserRuntime.runFork(customersData.refresh(allCustomers));
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

interface CustomerFilterRowProps {
  readonly onSearchChange: (search: string) => void;
  readonly onSegmentChange: (segment: string) => void;
  readonly onStatusChange: (status: string) => void;
  readonly onTagChange: (tagId: TagId | null) => void;
  readonly search: string;
  /** Null hides the segment select, which appears only while segments load. */
  readonly segmentFilter: string | null;
  readonly statusFilter: string;
  readonly tagFilter: TagId | null;
  readonly tagFilterFailed: boolean;
  readonly tagFilterLoading: boolean;
}

/** The one filter row: search, status, tag and segment, all size sm at fixed widths. */
const CustomerFilterRow = ({
  onSearchChange,
  onSegmentChange,
  onStatusChange,
  onTagChange,
  search,
  segmentFilter,
  statusFilter,
  tagFilter,
  tagFilterFailed,
  tagFilterLoading,
}: CustomerFilterRowProps) => {
  const { t } = useModernI18n();
  const segmentItems = [
    { label: t(`${key}.filters.allSegments`), value: allSegments },
    ...customerSegmentDefinitions.map((definition) => ({ label: definition.name, value: definition.businessCode })),
  ];
  const statusItems = [
    { label: t(`${key}.filters.allStatuses`), value: allStatuses },
    { label: t(`${key}.status.ACTIVE`), value: 'ACTIVE' },
    { label: t(`${key}.status.ARCHIVED`), value: 'ARCHIVED' },
  ];
  return (
    <>
      <div className="flex flex-wrap items-end gap-150">
        <Input
          aria-label={t(`${key}.table.searchLabel`)}
          className="w-64"
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t(`${key}.search.placeholder`)}
          size="sm"
          type="search"
          value={search}
        />
        <div className="w-48">
          <SelectTemplate
            items={statusItems}
            label={t(`${key}.columns.status`)}
            name="status"
            onValueChange={(details) => {
              const [next] = details.value;
              onStatusChange(next ?? allStatuses);
            }}
            placeholder={t('party-registry.selectPlaceholder')}
            size="sm"
            value={[statusFilter]}
          />
        </div>
        <TagFilter kind="customer" onChange={onTagChange} value={tagFilter} />
        {segmentFilter !== null && (
          <div className="w-48">
            <SelectTemplate
              items={segmentItems}
              label={t(`${key}.columns.segment`)}
              name="segment"
              onValueChange={(details) => {
                const [next] = details.value;
                onSegmentChange(next ?? allSegments);
              }}
              placeholder={t('party-registry.selectPlaceholder')}
              size="sm"
              value={[segmentFilter]}
            />
          </div>
        )}
      </div>
      {tagFilterLoading && <p className="text-fg-secondary text-sm">{t(`${key}.tags.filtering`)}</p>}
      {tagFilterFailed && <StatusText status="error">{t(`${key}.tags.filterFailed`)}</StatusText>}
    </>
  );
};

interface CustomerBulkBarProps {
  readonly onClear: () => void;
  /** Absent without customer write: the only bulk edit left is tags, which the Štítky button already offers. */
  readonly onEdit: (() => void) | undefined;
  readonly onExport: () => void;
  readonly onTags: () => void;
  readonly selectedCount: number;
  /** False without tagging write, so a read-only role never opens a tag panel the owner would refuse. */
  readonly tagsWritable: boolean;
}

const CustomerBulkBar = ({ onClear, onEdit, onExport, onTags, selectedCount, tagsWritable }: CustomerBulkBarProps) => {
  const { t } = useModernI18n();
  return (
    <BulkActionBar onClear={onClear} selectedCount={selectedCount}>
      {tagsWritable && (
        <Button icon="icon-[mdi--tag-multiple-outline]" onClick={onTags} size="sm" theme="outlined" variant="secondary">
          {t(`${key}.bulk.tags`)}
        </Button>
      )}
      {onEdit !== undefined && (
        <Button icon="icon-[mdi--square-edit-outline]" onClick={onEdit} size="sm" theme="outlined" variant="secondary">
          {t(`${key}.bulk.edit`)}
        </Button>
      )}
      <Button
        icon="icon-[mdi--file-delimited-outline]"
        onClick={onExport}
        size="sm"
        theme="outlined"
        variant="secondary"
      >
        {t(`${key}.bulk.exportCsv`)}
      </Button>
    </BulkActionBar>
  );
};

interface CustomersEmptyProps {
  /** A narrowing filter hides every loaded customer, so the table offers to clear filters instead of creating. */
  readonly filtered: boolean;
  readonly onClearFilters: () => void;
  /** Absent when the owner refused customer writes for this role. */
  readonly onCreate: (() => void) | undefined;
  readonly onRetry: () => void;
  readonly status: LoadState['status'];
}

/** The table's empty body: load error, no access, no filter match, or an empty register. */
const CustomersEmpty = ({ filtered, onClearFilters, onCreate, onRetry, status }: CustomersEmptyProps) => {
  const { t } = useModernI18n();
  if (status === 'error') {
    return (
      <EmptyState
        action={
          <Button onClick={onRetry} size="sm" theme="outlined" variant="secondary">
            {t(`${key}.state.retry`)}
          </Button>
        }
        description={t(`${key}.state.loadErrorDescription`)}
        title={t(`${key}.state.loadError`)}
      />
    );
  }
  if (status === 'forbidden') {
    return <EmptyState title={t(`${key}.state.forbidden`)} />;
  }
  if (filtered) {
    return (
      <EmptyState
        action={
          <Button onClick={onClearFilters} size="sm" theme="outlined" variant="secondary">
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
        onCreate === undefined ? undefined : (
          <Button onClick={onCreate} size="sm" theme="outlined" variant="secondary">
            {t(`${key}.newCustomer`)}
          </Button>
        )
      }
      description={t(`${key}.state.emptyDescription`)}
      title={t(`${key}.state.emptyTitle`)}
    />
  );
};

const CustomersContent = () => {
  const { t } = useModernI18n();
  // Every customer, archived included, so the stat tiles describe the whole register. The Shell preloads it.
  const state = loadStateOf(useSyncExternalStore(customersData.subscribe, readCustomers, serverSnapshot));
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Selection>({});
  const { closeDetail, detail, detailFailure, detailValue, openDetail, retryDetail } = useCustomerDetailSelection();
  const [createOpen, setCreateOpen] = useState(false);
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibility>(defaultColumnVisibility);
  const [editOpen, setEditOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [segmentFilter, setSegmentFilter] = useState<string>(allSegments);
  const [statusFilter, setStatusFilter] = useState<string>(defaultStatusFilter);
  /** The owner refused a customer write for this role, so create and archive actions are hidden. */
  const [writesRefused, setWritesRefused] = useState(customerWritesRefused);
  const refuseWrites = () => {
    rememberCustomerWriteRefusal();
    setWritesRefused(true);
  };

  useEffect(() => customersData.ensure(allCustomers), []);

  const data = state.status === 'ready' ? state.data : undefined;
  const items = data?.items ?? [];
  const enrichment = useCustomerEnrichment(data);
  const { segments, tagFilter, taggedIds, tagsBySubject, tagStatus } = enrichment;

  // The segment filter exists only while segments load, so a hidden filter never narrows the rows.
  const segmentsShown = segments !== null && !enrichment.segmentsFailed;
  const visible = items.filter(
    (item) =>
      (statusFilter === allStatuses || item.status === statusFilter) &&
      matchesCustomerSearch(item, search) &&
      (tagFilter === null || (taggedIds?.has(item.partyId) ?? false)) &&
      (!segmentsShown || segmentFilter === allSegments || segments?.get(item.partyId)?.code === segmentFilter),
  );
  const stats = data === undefined ? undefined : computeCustomerStats(data.items, data.nowMillis);
  const selectedItems = items.filter((item) => selection[item.counterpartyId] === true);
  const selectedSubjectIds = selectedItems.map((item) => subjectIdOf(item.partyId));
  const statusLabel = (item: CustomerListItem) => t(`${key}.status.${item.status}`);
  const segmentCell = (info: CellContext<CustomerListItem>) => segments?.get(info.row.original.partyId)?.name ?? '—';
  // Segment lookup is best effort: a failed lookup drops the column and shows no error banner.
  const segmentColumns: ColumnDef<CustomerListItem>[] = enrichment.segmentsFailed
    ? []
    : [
        {
          cell: segmentCell,
          enableSorting: false,
          header: t(`${key}.columns.segment`),
          id: 'segment',
          meta: { width: 120 },
        },
      ];
  const tagsCell = (info: CellContext<CustomerListItem>) => {
    if (tagStatus === 'error') {
      return <span className="text-sm">{t(`${key}.tags.failed`)}</span>;
    }
    return <TagCell tags={tagsBySubject.get(subjectIdOf(info.row.original.partyId)) ?? []} />;
  };

  // Eight visible columns at 1440px; DIČ and Stav live in the column menu.
  const columns: ColumnDef<CustomerListItem>[] = [
    {
      accessorKey: 'displayName',
      cell: nameCell,
      header: t(`${key}.columns.name`),
      meta: { width: 220 },
      sortFn: (rowA, rowB, columnId) =>
        czechCollator.compare(
          rowA.getValue<string | null>(columnId) ?? '',
          rowB.getValue<string | null>(columnId) ?? '',
        ),
    },
    { accessorKey: 'companyId', cell: textCell, header: t(`${key}.columns.companyId`), meta: { width: 100 } },
    { accessorKey: 'city', cell: textCell, header: t(`${key}.columns.city`), meta: { width: 130 } },
    { accessorKey: 'email', cell: textCell, header: t(`${key}.columns.email`), meta: { width: 210 } },
    { accessorKey: 'phone', cell: textCell, header: t(`${key}.columns.phone`), meta: { width: 140 } },
    ...segmentColumns,
    {
      accessorKey: 'createdAt',
      cell: dateCell,
      header: t(`${key}.columns.createdAt`),
      meta: { type: 'date', width: 110 },
    },
    { cell: tagsCell, enableSorting: false, header: t(`${key}.columns.tags`), id: 'tags', meta: { width: 180 } },
    { accessorKey: 'vatId', cell: textCell, header: t(`${key}.columns.vatId`), meta: { width: 130 } },
    {
      accessorFn: statusLabel,
      cell: statusCell,
      header: t(`${key}.columns.status`),
      id: 'status',
      meta: { width: 120 },
    },
  ];

  const translations: DataTableTranslations = {
    ...dataTableRowLabels,
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

  // Any narrowing filter, the default Aktivní status included, makes an empty table read "no match", not "no customers".
  const filtered =
    items.length > 0 &&
    (search.trim().length > 0 ||
      statusFilter !== allStatuses ||
      tagFilter !== null ||
      (segmentsShown && segmentFilter !== allSegments));
  const clearFilters = () => {
    setSearch('');
    setStatusFilter(allStatuses);
    setSegmentFilter(allSegments);
    enrichment.handleTagFilterChange(null);
  };

  const openCreate = () => setCreateOpen(true);

  const renderEmpty = () => (
    <CustomersEmpty
      filtered={filtered}
      onClearFilters={clearFilters}
      onCreate={writesRefused ? undefined : openCreate}
      onRetry={reload}
      status={state.status}
    />
  );

  return (
    <>
      <UltramodernRouteHead titleKey="party-registry.pages.customers.title" />
      {/* The shell mounts no Toaster for remotes and ui-kit is not an MF singleton, so this page tree owns one. */}
      <Toaster />
      <div className="flex min-w-0 flex-col gap-250">
        <PageHeader
          actions={
            writesRefused ? undefined : (
              <Button icon="icon-[mdi--plus]" onClick={openCreate} size="sm" variant="primary">
                {t(`${key}.newCustomer`)}
              </Button>
            )
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

        <CustomerFilterRow
          onSearchChange={setSearch}
          onSegmentChange={setSegmentFilter}
          onStatusChange={setStatusFilter}
          onTagChange={enrichment.handleTagFilterChange}
          search={search}
          segmentFilter={segmentsShown ? segmentFilter : null}
          statusFilter={statusFilter}
          tagFilter={tagFilter}
          tagFilterFailed={enrichment.tagFilterFailed}
          tagFilterLoading={enrichment.tagFilterLoading}
        />

        <CustomerBulkBar
          onClear={() => setSelection({})}
          onEdit={writesRefused ? undefined : () => setEditOpen(true)}
          onExport={exportSelected}
          onTags={() => setTagOpen(true)}
          selectedCount={selectedItems.length}
          tagsWritable={enrichment.tagsWritable}
        />

        <DataTable
          columnPinning={pinning}
          columns={columns}
          columnVisibility={columnVisibility}
          data={visible}
          enableColumnPinning
          enableColumnVisibility
          enablePagination
          enableRowSelection
          enableSorting
          getRowId={(row) => row.counterpartyId}
          getRowLabel={(row) => row.original.displayName ?? row.original.counterpartyId}
          loading={state.status === 'loading' || enrichment.tagFilterLoading}
          loadingRowCount={12}
          maxHeight="calc(100dvh - 15rem)"
          onColumnVisibilityChange={setColumnVisibility}
          onRowClick={(row) => openDetail(row.original)}
          onRowSelectionChange={setSelection}
          pageSizeOptions={pageSizeOptions}
          paginationProps={{ translations: paginationTranslations }}
          renderEmpty={renderEmpty}
          rowSelection={selection}
          size="sm"
          stickyHeader
          tableLayout="fixed"
          translations={translations}
        />
      </div>

      <CustomerCreateDialog
        existing={items}
        onCreated={reload}
        onOpenChange={setCreateOpen}
        onWriteRefused={refuseWrites}
        open={createOpen}
      />
      <CustomerDetailDialog
        customer={detail}
        failure={detailFailure}
        onOpenChange={closeDetail}
        onRenamed={reload}
        onRetry={retryDetail}
        snapshot={detailValue}
      />
      <CustomerBulkEditDialog
        canTag={enrichment.tagsWritable}
        items={selectedItems}
        onArchived={reload}
        onChooseTag={() => setTagOpen(true)}
        onOpenChange={setEditOpen}
        onWriteRefused={refuseWrites}
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

/** The Shell awaits this before it reveals the page, so the first render already has rows, stats and segments. */
export { preloadCustomers as preloadPage } from './customers-data.ts';
export default CustomersPage;
