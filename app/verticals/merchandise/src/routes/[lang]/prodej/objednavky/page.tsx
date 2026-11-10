import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { DataTableProps } from '@techsio/ui-kit/organisms/data-table';
import { SelectTemplate } from '@app/admin-ui/select-template';
import {
  BulkActionBar,
  DetailViewModeToggle,
  EmptyState,
  formatNumber,
  PageHeader,
  StatCard,
  StatRow,
  statusPresentation,
  Toaster,
  useDetailViewMode,
} from '@app/admin-ui';
import { BulkTagDialog, TagFilter } from '@app/tagging/components/tag-controls';
import { modulePagePreload, pageDataScopeKey } from '@app/shared-contracts/page-data';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { Effect, Option, Schema, SchemaGetter } from 'effect';
import { useNavigate, useRouterState } from '@modern-js/plugin-tanstack/runtime';
import type { RegisteredRouter } from '@tanstack/react-router';
import { useState } from 'react';
import type { Order } from '../../../../../shared/apis/records.ts';
import type { OrderStatus } from '../../../../../shared/domain/merchandise-model.ts';
import { storefrontBrandOf } from '../../../../../shared/domain/storefront-brand.ts';
import csResource from '../../../../../locales/cs/merchandise.json';
import enResource from '../../../../../locales/en/merchandise.json';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { legalEntityOf } from '../../../../runtime/page-data-hooks.ts';
import { toSubjectIds, useSubjectTagFilter, useSubjectTags } from '../../../../tags/subject-tags.ts';
import type { SubjectTagFilter } from '../../../../tags/subject-tags.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';
import { paginationProps } from '../../../../form-number.ts';
import { formatKc } from '../../../../list-format.ts';
import { customersMatching, useCustomerDirectory } from './customers-directory.ts';
import { OrderCancelDialog } from './order-cancel-dialog.tsx';
import { OrderCreateDialog } from './order-create-dialog.tsx';
import { selectItem } from '../../../../ui/select-item.ts';
import { OrderDetailDialog } from './order-detail-dialog.tsx';
import { OrderDetailPage } from './order-detail-page.tsx';
import { orderNavigationFailureKey } from './order-navigation.ts';
import { proposalToast, statusChangeNotification } from './order-status-notice.ts';
import { ResetDemoDialog } from './reset-demo-dialog.tsx';
import { commonOrderTransitions, ordersPageSummary, orderStatuses, transitionsFrom } from './orders-model.ts';
import {
  changeOrderStatuses,
  preloadOrdersPage,
  recordsCanEditOrders,
  useOrderDetail,
  useOrders,
} from './orders-records.ts';
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
const bulkStatusItems = orderStatuses.map((value) => selectItem(value, statusPresentation('order', value).label));

/** With a tag filter active, order tags still loading read as loading, never as no match. */
const isTableLoading = (ordersLoading: boolean, tagStatus: SubjectTagFilter['status']): boolean =>
  ordersLoading || tagStatus === 'loading';

const bulkSelectionHint = (hasSelection: boolean, canWriteTags: boolean) => {
  if (hasSelection) {
    return 'bulk.selectionScope';
  }
  return canWriteTags ? 'bulk.selectHint' : 'bulk.selectStatusHint';
};

const bulkUnavailableStatusHint = (allFinal: boolean, canWriteTags: boolean) => {
  if (!allFinal) {
    return 'bulk.noCommonStatus';
  }
  return canWriteTags ? 'bulk.finalStatus' : 'bulk.finalStatusOnly';
};

interface OrdersPageContentProps {
  readonly context?: ModulePageProps['context'];
  readonly legalEntityId: string;
}

const OrdersPageSearchSchema = Schema.Struct({
  orderId: Schema.optionalKey(Schema.String.pipe(Schema.brand('OrdersPageOrderIdParameter'))),
});
const ordersQueryString = Schema.toCodecJson(Schema.URLSearchParams);
/** Decode the original query spelling, including leading zeroes and the first repeated exact key. */
const OrdersPageQuerySchema = ordersQueryString.pipe(
  Schema.decodeTo<typeof OrdersPageSearchSchema, typeof ordersQueryString>(OrdersPageSearchSchema, {
    decode: SchemaGetter.transform((params) => {
      const orderId = params.get('orderId');
      return orderId === null ? {} : { orderId };
    }),
    encode: SchemaGetter.encodeURLSearchParams(),
  }),
);
/** The order `?orderId=` names, if any. */
const orderIdOfSearch = (searchStr: string): string | undefined =>
  Schema.decodeOption(OrdersPageQuerySchema)(searchStr).pipe(
    Option.flatMap((decodedSearch) => Option.fromNullishOr(decodedSearch.orderId)),
    Option.filter((orderId) => orderId !== ''),
    Option.getOrUndefined,
  );

const useOrdersPage = ({ context, legalEntityId }: OrdersPageContentProps) => {
  const { language, t } = useModernI18n();
  const navigate = useNavigate();
  const toaster = useToast();
  const [viewMode, setViewMode] = useDetailViewMode();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<OrderStatus | null>(null);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: PAGE_SIZE });
  const settledSearch = useDebounced(search);
  // Dispatch processes order snapshots; it has no customer-directory or tagging access. Known after the first read.
  const [canEditOrders, setCanEditOrders] = useState(false);
  const directory = useCustomerDirectory(legalEntityId, canEditOrders);
  const customerEntries = directory.entries;
  const customerPartyIds = customersMatching(customerEntries, settledSearch);
  const tagFilter = useSubjectTagFilter('order');
  const taggedIds = tagFilter.ids;
  const query: OrdersQuery = {
    customerPartyIds,
    limit: pagination.pageSize,
    offset: pagination.pageIndex * pagination.pageSize,
    search: settledSearch,
    status: statusFilter,
    taggedIds,
  };
  const orders$ = useOrders(legalEntityId, query, context);
  const { state } = orders$;
  // Selected orders by id, kept across pages: bulk actions need each order's status, not only its id.
  const [selectedOrders, setSelectedOrders] = useState<Readonly<Record<string, Order>>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  // In panel mode `?orderId=` (e.g. from an opportunity's related orders) opens that order in the panel.
  const initialSearch = useRouterState({ select: (router) => router.location.searchStr });
  const [detailId, setDetailId] = useState<string | null>(() =>
    globalThis.location === undefined ? null : (orderIdOfSearch(initialSearch) ?? null),
  );
  const [pendingCancel, setPendingCancel] = useState<readonly Order[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [detailVersion, setDetailVersion] = useState(0);
  const detail = useOrderDetail(detailId, detailVersion, context, {
    legalEntityId,
    query,
    scope: pageDataScopeKey(context, 'demo.merchandise'),
  });
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
  const readyCanEditOrders = ready === undefined ? canEditOrders : recordsCanEditOrders(ready.records);
  if (readyCanEditOrders !== canEditOrders) {
    setCanEditOrders(readyCanEditOrders);
  }
  const orderTags = useSubjectTags('order', canEditOrders ? orders.map((order) => order.id) : []);
  const statusItems = [selectItem(ALL_STATUSES, t(key('filters.allStatuses'))), ...bulkStatusItems];
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
  const selectedStatusItems = availableBulkStatuses.map((value) =>
    selectItem(value, statusPresentation('order', value).label),
  );
  const filtered = search.trim() !== '' || statusFilter !== null || tagFilter.tagId !== null;
  const stale = ready !== undefined && ready.query !== query;

  const runStatusChange = (targets: readonly Order[], status: OrderStatus, reason?: string) => {
    if (ready === undefined) {
      return;
    }
    setBusy(true);
    const input: {
      -readonly [Key in keyof Parameters<typeof changeOrderStatuses>[0]]: Parameters<
        typeof changeOrderStatuses
      >[0][Key];
    } = {
      orders: targets,
      revision: ready.records.revision,
      status,
    };
    if (reason !== undefined) {
      input.reason = reason;
    }
    void browserRuntime.runPromise(
      changeOrderStatuses(input).pipe(
        Effect.flatMap(({ changed, failed, proposals }) =>
          Effect.sync(() => {
            for (const proposal of proposals ?? []) {
              toaster.create(proposalToast(proposal, t));
            }
            if (changed > 0 || failed > 0) {
              toaster.create(statusChangeNotification(t, status, changed + failed, changed, failed));
            }
            setSelectedOrders({});
            setBusy(false);
            setPendingCancel(null);
            load();
          }),
        ),
      ),
    );
  };

  /**
   * A row opens the full order page by default. In panel mode it opens the quick-view panel instead, which
   * retargets when another row is clicked.
   */
  const navigateToOrder = navigate<RegisteredRouter, string>;
  const openDetail = (id: Order['id']) => {
    if (viewMode === 'panel') {
      setDetailId(id);
      return;
    }
    void browserRuntime.runPromise(
      Effect.tryPromise(
        navigateToOrder.bind(undefined, {
          search: { orderId: id },
          to: `/${language ?? 'cs'}/prodej/objednavky`,
        }),
      ).pipe(
        Effect.timeout('10 seconds'),
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              const messageKey = orderNavigationFailureKey(error);
              toaster.create({ title: t(key(messageKey)), type: 'error' });
            }),
          onSuccess: Effect.succeed,
        }),
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

  return {
    availableBulkStatuses,
    busy,
    canEditOrders,
    canWrite,
    createOpen,
    detail,
    directory,
    filtered,
    load,
    openDetail,
    orders,
    orderTags,
    pagination,
    pendingCancel,
    ready,
    refilter,
    requestStatus,
    resetOpen,
    runStatusChange,
    search,
    selected,
    selectedOrdersAreFinal,
    selectedStatusItems,
    selection,
    setCreateOpen,
    setDetailId,
    setPagination,
    setPendingCancel,
    setResetOpen,
    setSearch,
    setSelectedOrders,
    setSelection,
    setStatusFilter,
    setTagsOpen,
    setViewMode,
    stale,
    state,
    stats,
    statusFilter,
    statusItems,
    t,
    tagFilter,
    tagsOpen,
    toaster,
    totalOrders,
    viewMode,
  };
};

const renderOrderStats = ({ stats, t }: ReturnType<typeof useOrdersPage>) => (
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
);

const renderOrdersPageHeader = ({
  canWrite,
  ready,
  setCreateOpen,
  setResetOpen,
  setViewMode,
  t,
  viewMode,
}: ReturnType<typeof useOrdersPage>) => (
  <PageHeader
    actions={
      <div className="flex flex-wrap items-center gap-100">
        <DetailViewModeToggle
          groupLabel={t('merchandise.detailView.group')}
          onChange={setViewMode}
          pageLabel={t('merchandise.detailView.page')}
          panelLabel={t('merchandise.detailView.panel')}
          value={viewMode}
        />
        {(ready?.records.canEditOrders ?? canWrite) || ready?.records.canResetDemo === true ? (
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
                {t(key('actions.resetDemo'))}
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
        ) : undefined}
      </div>
    }
    description={t(key('description'))}
    title={t(key('title'))}
  />
);

/** Bulk controls keep the same selected orders and callbacks as the table model. */
const renderOrderBulkActions = ({
  availableBulkStatuses,
  busy,
  canWrite,
  orderTags,
  requestStatus,
  selected,
  selectedOrdersAreFinal,
  selectedStatusItems,
  setSelectedOrders,
  setTagsOpen,
  t,
}: ReturnType<typeof useOrdersPage>) =>
  canWrite && (
    <>
      <StatusText status="default">{t(key(bulkSelectionHint(selected.length > 0, orderTags.canWrite)))}</StatusText>
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
            {t(key(bulkUnavailableStatusHint(selectedOrdersAreFinal, orderTags.canWrite)))}
          </StatusText>
        )}
      </BulkActionBar>
    </>
  );

/** Empty content belongs to the visible table viewport, not the full column width. */
const renderOrdersEmpty = ({
  canEditOrders,
  filtered,
  load,
  refilter,
  setCreateOpen,
  setSearch,
  setStatusFilter,
  state,
  t,
  tagFilter,
}: ReturnType<typeof useOrdersPage>) => {
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
};

const OrdersPageContent = (props: OrdersPageContentProps) => {
  const model = useOrdersPage(props);
  const {
    busy,
    canEditOrders,
    canWrite,
    createOpen,
    detail,
    directory,
    load,
    openDetail,
    orders,
    orderTags,
    pagination,
    pendingCancel,
    ready,
    refilter,
    requestStatus,
    resetOpen,
    runStatusChange,
    search,
    selected,
    selection,
    setCreateOpen,
    setDetailId,
    setPagination,
    setPendingCancel,
    setResetOpen,
    setSearch,
    setSelectedOrders,
    setSelection,
    setStatusFilter,
    setTagsOpen,
    stale,
    state,
    statusFilter,
    statusItems,
    t,
    tagFilter,
    tagsOpen,
    toaster,
    totalOrders,
  } = model;

  return (
    <>
      <UltramodernRouteHead />
      <section className="flex min-w-0 flex-col gap-250">
        {renderOrdersPageHeader(model)}

        {renderOrderStats(model)}

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
              <TagFilter
                kind="order"
                onChange={(tagId) => {
                  tagFilter.setTagId(tagId);
                  refilter();
                }}
                value={tagFilter.tagId}
              />
            </div>
          )}
        </div>
        {tagFilter.status === 'error' && (
          <StatusText showIcon status="error">
            {t(key('states.tagFilterFailed'))}
          </StatusText>
        )}

        {renderOrderBulkActions(model)}

        <DataTable
          className="@container"
          columnPinning={{ end: [], start: ['__select', 'number'] }}
          columns={ordersColumns(t, directory, orderTags.tagsOf)}
          // A failed tag read never shows the unfiltered list as if it matched the tag.
          data={tagFilter.status === 'error' ? [] : [...orders]}
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
          onRowClick={(row) => openDetail(row.original.id)}
          onRowSelectionChange={setSelection}
          pageSizeOptions={[50, 100, 200]}
          pagination={pagination}
          paginationProps={paginationProps(t)}
          renderEmpty={() => <div className="sticky start-0 w-[100cqi] max-w-full">{renderOrdersEmpty(model)}</div>}
          rowCount={tagFilter.status === 'error' ? 0 : totalOrders}
          rowSelection={selection}
          size="sm"
          stickyHeader
          striped
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
          brand={storefrontBrandOf(props.legalEntityId)}
          busy={busy}
          canCleanupDemo={ready?.records.canCleanupDemo === true}
          canEditOrders={ready?.records.canEditOrders ?? canWrite}
          canWrite={canWrite}
          currentPrincipalId={ready?.records.actorPrincipalRef.principalId}
          customers={directory}
          detail={detail}
          onClose={() => setDetailId(null)}
          onEdited={(message) => {
            toaster.create({ title: message, type: 'success' });
            load();
          }}
          onRetry={load}
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
            if (tagFilter.tagId !== null) {
              // The selected tag gained or lost orders: read its subjects (and so the page) again.
              tagFilter.refetch();
            }
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

/** With the full page chosen, `?orderId=` shows that order's page in place of the list; the panel keeps the list. */
const OrdersRoute = ({ context, legalEntityId }: OrdersPageContentProps) => {
  const [viewMode] = useDetailViewMode();
  const orderId = orderIdOfSearch(useRouterState({ select: (router) => router.location.searchStr }));
  return viewMode === 'page' && orderId !== undefined ? (
    <OrderDetailPage context={context} key={orderId} legalEntityId={legalEntityId} orderId={orderId} />
  ) : (
    <OrdersPageContent context={context} legalEntityId={legalEntityId} />
  );
};

/** The Shell prepares the first page, its header counts and the customer names before it reveals the page. */
export const preloadPage = modulePagePreload((props) =>
  preloadOrdersPage(legalEntityOf(props), PAGE_SIZE, props.context),
);

export const OrdersPage = (props: Partial<ModulePageProps>) => (
  <FederatedI18nBoundary
    defaultNamespace="merchandise"
    fallbackLanguage="en"
    resources={merchandiseI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <OrdersRoute
      context={props.context}
      key={pageDataScopeKey(props.context, 'demo.merchandise') ?? legalEntityOf(props)}
      legalEntityId={legalEntityOf(props)}
    />
  </FederatedI18nBoundary>
);

export default OrdersPage;
