import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { DataTableProps } from '@techsio/ui-kit/organisms/data-table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import {
  BulkActionBar,
  EmptyState,
  formatNumber,
  PageHeader,
  StatCard,
  StatRow,
  statusPresentation,
  Toaster,
} from '@app/admin-ui';
import { BulkTagDialog, TagFilter } from '@app/tagging/components/tag-controls';
import { Effect } from 'effect';
import { useMemo, useState } from 'react';
import type { Order } from '../../../../../shared/apis/records.ts';
import type { OrderStatus } from '../../../../../shared/domain/merchandise-model.ts';
import csResource from '../../../../../locales/cs/merchandise.json';
import enResource from '../../../../../locales/en/merchandise.json';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { toSubjectIds, useSubjectTagFilter, useSubjectTags } from '../../../../tags/subject-tags.ts';
import type { SubjectTagFilter } from '../../../../tags/subject-tags.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';
import { paginationProps } from '../../../../form-number.ts';
import { formatKc } from '../../../../list-cells.tsx';
import { useCustomerDirectory } from './customers-directory.ts';
import { OrderCancelDialog } from './order-cancel-dialog.tsx';
import { OrderCreateDialog } from './order-create-dialog.tsx';
import { OrderDetailDialog } from './order-detail-dialog.tsx';
import { ResetDemoDialog } from './reset-demo-dialog.tsx';
import {
  commonOrderTransitions,
  ordersPageSummary,
  orderStatuses,
  statusDoneKey,
  transitionsFrom,
} from './orders-model.ts';
import { changeOrderStatuses, useOrderDetail, useOrders } from './orders-records.ts';
import type { OrdersQuery } from './orders-records.ts';
import { useDebounced } from '../../provoz/produkty/product-reads.ts';
import { ordersColumns, ordersTranslations } from './orders-table.tsx';

const merchandiseI18nResources = {
  cs: { merchandise: csResource },
  en: { merchandise: enResource },
} as const;

const key = (path: string) => `merchandise.pages.orders.${path}`;

type OrderTableProps = DataTableProps<Order>;
type RowSelection = NonNullable<OrderTableProps['rowSelection']>;

const ALL_STATUSES = '__all__';
const PAGE_SIZE = 50;
const bulkStatusItems = orderStatuses.map((value) => ({ label: statusPresentation('order', value).label, value }));

/** With a tag filter active, order tags still loading read as loading, never as no match. */
const isTableLoading = (ordersLoading: boolean, tagStatus: SubjectTagFilter['status']): boolean =>
  ordersLoading || tagStatus === 'loading';

const statusChangeNotification = (
  t: ReturnType<typeof useModernI18n>['t'],
  status: OrderStatus,
  total: number,
  changed: number,
  failed: number,
) => {
  if (failed > 0) {
    return {
      description: t(key('bulk.result'), { changed, failed }),
      title: t(key('bulk.partial')),
      type: 'error',
    } satisfies Parameters<ReturnType<typeof useToast>['create']>[0];
  }
  const doneKey = statusDoneKey(status);
  return {
    title: total === 1 && doneKey !== null ? t(doneKey) : t(key('bulk.success')),
    type: 'success',
  } satisfies Parameters<ReturnType<typeof useToast>['create']>[0];
};

const OrdersPageContent = () => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<OrderStatus | null>(null);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: PAGE_SIZE });
  const settledSearch = useDebounced(search);
  const query = useMemo<OrdersQuery>(
    () => ({
      limit: pagination.pageSize,
      offset: pagination.pageIndex * pagination.pageSize,
      search: settledSearch,
      status: statusFilter,
    }),
    [pagination, settledSearch, statusFilter],
  );
  const orders$ = useOrders(query);
  const { state } = orders$;
  // Selected orders by id, kept across pages: bulk actions need each order's status, not only its id.
  const [selectedOrders, setSelectedOrders] = useState<Readonly<Record<string, Order>>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  // `?orderId=` (e.g. from an opportunity's related orders) opens that order's detail.
  const [detailId, setDetailId] = useState<string | null>(() =>
    globalThis.location === undefined ? null : new URL(globalThis.location.href).searchParams.get('orderId'),
  );
  const [pendingCancel, setPendingCancel] = useState<readonly Order[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [detailVersion, setDetailVersion] = useState(0);
  const detail = useOrderDetail(detailId, detailVersion);
  const ready = state.kind === 'ready' ? state : undefined;
  const { canWrite, orders, stats, totalOrders } = ordersPageSummary(ready);
  /** Every change reloads the page, the header counts and the open detail. */
  const load = () => {
    orders$.load();
    setDetailVersion((current) => current + 1);
  };
  /** A filter change starts again at the first page and drops the selection made under the old filter. */
  const refilter = () => {
    setPagination((current) => (current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }));
    setSelectedOrders({});
  };
  // Dispatch processes order snapshots; it has no customer-directory or tagging access.
  const canEditOrders = (ready?.records.canEditOrders ?? canWrite) === true;
  const directory = useCustomerDirectory(canEditOrders);
  const orderTags = useSubjectTags('order', canEditOrders ? orders.map((order) => order.id) : []);
  const tagFilter = useSubjectTagFilter(orderTags);
  const statusItems = [{ label: t(key('filters.allStatuses')), value: ALL_STATUSES }, ...bulkStatusItems];
  // The tag filter has no server counterpart yet: it narrows the page on screen.
  const visible = orders.filter((order) => tagFilter.matches(order.id));
  const selected = Object.values(selectedOrders);
  const selection: RowSelection = Object.fromEntries(selected.map((order) => [order.id, true]));
  const setSelection = (next: RowSelection) => {
    const onPage = new Map<string, Order>(orders.map((order) => [order.id, order]));
    setSelectedOrders((current) =>
      Object.fromEntries(
        Object.keys(next).flatMap((id) => {
          const order = onPage.get(id) ?? current[id];
          return next[id] === true && order !== undefined ? [[id, order] as const] : [];
        }),
      ),
    );
  };
  const availableBulkStatuses = commonOrderTransitions(selected);
  const selectedOrdersAreFinal = selected.every((order) => transitionsFrom(order.status).length === 0);
  const selectedStatusItems = availableBulkStatuses.map((value) => ({
    label: statusPresentation('order', value).label,
    value,
  }));
  const filtered = search.trim() !== '' || statusFilter !== null || tagFilter.tagId !== null;
  const stale = ready !== undefined && ready.query !== query;

  const runStatusChange = (targets: readonly Order[], status: OrderStatus, reason?: string) => {
    if (ready === undefined) {
      return;
    }
    setBusy(true);
    void browserRuntime.runPromise(
      changeOrderStatuses({
        orders: targets,
        revision: ready.records.revision,
        status,
        ...(reason === undefined ? {} : { reason }),
      }).pipe(
        Effect.flatMap(({ changed, failed }) =>
          Effect.sync(() => {
            toaster.create(statusChangeNotification(t, status, targets.length, changed, failed));
            setSelectedOrders({});
            setBusy(false);
            setPendingCancel(null);
            load();
          }),
        ),
      ),
    );
  };

  /** Cancelling asks first. Opening the confirm closes the detail dialog so dialogs never stack. */
  const requestStatus = (targets: readonly Order[], status: OrderStatus) => {
    if (targets.length === 0) {
      return;
    }
    if (status === 'CANCELLED') {
      setDetailId(null);
      setPendingCancel(targets);
      return;
    }
    runStatusChange(targets, status);
  };

  return (
    <>
      <UltramodernRouteHead />
      <section className="flex min-w-0 flex-col gap-250">
        <PageHeader
          actions={
            (ready?.records.canEditOrders ?? canWrite) || ready?.records.canResetDemo === true ? (
              <div className="flex flex-wrap items-center gap-100">
                {ready?.records.canResetDemo === true && (
                  <Button
                    className="shrink-0 whitespace-nowrap"
                    icon="icon-[mdi--restore]"
                    onClick={() => setResetOpen(true)}
                    size="sm"
                    theme="outlined"
                    variant="secondary"
                  >
                    Obnovit ukázková data
                  </Button>
                )}
                {(ready?.records.canEditOrders ?? canWrite) && (
                  <Button
                    className="shrink-0 whitespace-nowrap"
                    icon="icon-[mdi--plus]"
                    onClick={() => setCreateOpen(true)}
                    size="sm"
                    variant="primary"
                  >
                    {t(key('create.title'))}
                  </Button>
                )}
              </div>
            ) : undefined
          }
          description={t(key('description'))}
          title={t(key('title'))}
        />

        <StatRow>
          <StatCard label={t(key('stats.total'))} value={stats === undefined ? '—' : formatNumber(stats.total)} />
          <StatCard
            hint={t(key('stats.openHint'))}
            label={t(key('stats.open'))}
            value={stats === undefined ? '—' : formatKc(stats.openValueMinor)}
          />
          <StatCard
            label={t(key('stats.shipped'))}
            value={stats?.shipped === undefined ? '—' : formatNumber(stats.shipped)}
          />
          <StatCard
            label={t(key('stats.cancelled'))}
            value={stats?.cancelled === undefined ? '—' : formatNumber(stats.cancelled)}
          />
        </StatRow>

        <div className="flex flex-wrap items-end gap-150">
          <Input
            aria-label={t(key('table.searchLabel'))}
            className="w-64"
            onChange={(event) => {
              setSearch(event.target.value);
              refilter();
            }}
            placeholder={t(key('table.searchPlaceholder'))}
            size="sm"
            type="search"
            value={search}
          />
          <div className="w-48">
            <SelectTemplate
              items={statusItems}
              label={t(key('filters.status'))}
              name="statusFilter"
              onValueChange={(details) => {
                const [next] = details.value;
                setStatusFilter(orderStatuses.find((candidate) => candidate === next) ?? null);
                refilter();
              }}
              placeholder={t('merchandise.selectPlaceholder')}
              size="sm"
              value={[statusFilter ?? ALL_STATUSES]}
            />
          </div>
          {canEditOrders && (
            <div className="w-48">
              <TagFilter kind="order" onChange={(tagId) => tagFilter.setTagId(tagId)} value={tagFilter.tagId} />
            </div>
          )}
        </div>
        {tagFilter.status === 'error' && (
          <StatusText showIcon status="error">
            {t(key('states.tagFilterFailed'))}
          </StatusText>
        )}

        {canWrite && (
          <>
            <StatusText status="default">
              {t(
                key(
                  selected.length === 0
                    ? orderTags.canWrite
                      ? 'bulk.selectHint'
                      : 'bulk.selectStatusHint'
                    : 'bulk.selectionScope',
                ),
              )}
            </StatusText>
            <BulkActionBar onClear={() => setSelectedOrders({})} selectedCount={selected.length}>
              {orderTags.canWrite && (
                <Button
                  disabled={busy}
                  icon="icon-[mdi--tag-multiple-outline]"
                  onClick={() => setTagsOpen(true)}
                  size="sm"
                  theme="outlined"
                  variant="secondary"
                >
                  {t(key('bulk.tags'))}
                </Button>
              )}
              {availableBulkStatuses.length > 0 ? (
                <SelectTemplate
                  disabled={busy}
                  items={selectedStatusItems}
                  label={t(key('bulk.changeStatus'))}
                  labelProps={{ className: 'sr-only' }}
                  name="bulkStatus"
                  onValueChange={(details) => {
                    const [next] = details.value;
                    const status = availableBulkStatuses.find((candidate) => candidate === next);
                    if (status !== undefined) {
                      requestStatus(selected, status);
                    }
                  }}
                  placeholder={t(key('bulk.statusPlaceholder'))}
                  size="sm"
                  value={[]}
                />
              ) : (
                <StatusText showIcon status="default">
                  {t(
                    key(
                      selectedOrdersAreFinal
                        ? orderTags.canWrite
                          ? 'bulk.finalStatus'
                          : 'bulk.finalStatusOnly'
                        : 'bulk.noCommonStatus',
                    ),
                  )}
                </StatusText>
              )}
            </BulkActionBar>
          </>
        )}

        <DataTable
          columnPinning={{ end: [], start: ['__select', 'number'] }}
          columns={ordersColumns(t, directory, orderTags.tagsOf)}
          data={visible}
          enableColumnPinning
          enablePagination
          enableRowSelection
          enableSorting={false}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.original.number}
          loading={isTableLoading(state.kind === 'loading' || stale, tagFilter.status)}
          loadingRowCount={12}
          manualPagination
          maxHeight="calc(100dvh - 15rem)"
          onPaginationChange={setPagination}
          onRowClick={(row) => setDetailId(row.original.id)}
          onRowSelectionChange={setSelection}
          pageSizeOptions={[50, 100, 200]}
          pagination={pagination}
          paginationProps={paginationProps(t)}
          renderEmpty={() => {
            if (state.kind === 'error') {
              return (
                <EmptyState
                  action={
                    <Button onClick={load} size="sm" theme="outlined" variant="secondary">
                      {t(key('states.retry'))}
                    </Button>
                  }
                  description={t(key('states.errorDescription'))}
                  title={t(key('states.errorTitle'))}
                />
              );
            }
            if (state.kind === 'forbidden') {
              return <EmptyState title={t(key('states.forbiddenTitle'))} />;
            }
            if (filtered) {
              return (
                <EmptyState
                  action={
                    <Button
                      onClick={() => {
                        setSearch('');
                        setStatusFilter(null);
                        tagFilter.setTagId(null);
                        refilter();
                      }}
                      size="sm"
                      theme="outlined"
                      variant="secondary"
                    >
                      {t(key('states.clearFilters'))}
                    </Button>
                  }
                  title={t(key('states.filteredTitle'))}
                />
              );
            }
            return (
              <EmptyState
                action={
                  canEditOrders ? (
                    <Button onClick={() => setCreateOpen(true)} size="sm" theme="outlined" variant="secondary">
                      {t(key('create.title'))}
                    </Button>
                  ) : undefined
                }
                description={t(key('states.firstDescription'))}
                title={t(key('states.firstTitle'))}
              />
            );
          }}
          rowCount={totalOrders}
          rowSelection={selection}
          size="sm"
          stickyHeader
          tableLayout="fixed"
          translations={ordersTranslations(t)}
        />

        <OrderCreateDialog
          customers={directory}
          onCreated={load}
          onOpenChange={setCreateOpen}
          open={createOpen}
          revision={ready?.records.revision ?? 0}
        />

        <OrderDetailDialog
          busy={busy}
          canWrite={canWrite}
          canEditOrders={ready?.records.canEditOrders ?? canWrite}
          canCleanupDemo={ready?.records.canCleanupDemo === true}
          currentPrincipalId={ready?.records.actorPrincipalRef.principalId}
          customers={directory}
          detail={detail}
          onClose={() => setDetailId(null)}
          onEdited={(message) => {
            toaster.create({ title: message, type: 'success' });
            load();
          }}
          onStatus={(order, status) => requestStatus([order], status)}
          revision={Math.max(ready?.records.revision ?? 0, detail.status === 'ready' ? detail.revision : 0)}
        />

        <ResetDemoDialog
          onDismiss={() => setResetOpen(false)}
          onReset={(message) => {
            setResetOpen(false);
            setDetailId(null);
            toaster.create({ title: message, type: 'success' });
            load();
          }}
          open={resetOpen}
          revision={ready?.records.revision ?? 0}
        />

        <OrderCancelDialog
          busy={busy}
          onConfirm={(targets, reason) => runStatusChange(targets, 'CANCELLED', reason)}
          onDismiss={() => setPendingCancel(null)}
          orders={pendingCancel}
        />

        <BulkTagDialog
          kind="order"
          onDone={() => {
            setSelectedOrders({});
            orderTags.refetch();
          }}
          onOpenChange={setTagsOpen}
          open={tagsOpen}
          subjectIds={toSubjectIds(selected.map((order) => order.id))}
        />
        <Toaster />
      </section>
    </>
  );
};

export const OrdersPage = () => (
  <FederatedI18nBoundary
    defaultNamespace="merchandise"
    fallbackLanguage="en"
    resources={merchandiseI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <OrdersPageContent />
  </FederatedI18nBoundary>
);

export default OrdersPage;
