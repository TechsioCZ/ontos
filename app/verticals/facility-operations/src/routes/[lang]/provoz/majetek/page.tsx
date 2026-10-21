// @effect-diagnostics asyncFunction:off
// Facility operations — Majetek a odpisy (S02 evidence majetku, revize, inventury + S03 odpisové plány).
// OWNED BY THE `assets` LANE (ops-assets). Data: governed records read (agenda `assets`); every change is one
// command through the apply-command Action (shared/commands/assets.ts), then the agenda is reloaded.
import {
  PageHeader,
  SidePanel,
  dataTableRowLabels,
  paginationTranslations,
  StatCard,
  StatRow,
  foldSearchText,
  formatMoney,
  formatNumber,
} from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type {
  Asset,
  AssetsState,
  Inventory,
  InventoryItem,
  Investment,
} from '../../../../../shared/domain/assets.ts';
import { assetKinds, isActiveAsset, isArchivedAsset, upcomingServiceDue } from '../../../../../shared/domain/assets.ts';
import { AgendaFrame, AgendaGate } from '../../../../ui/agenda-frame.tsx';
import { useAgendaRecords } from '../../../../ui/use-agenda.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { AssetCardForm, FollowUpForm, InventoryCreateForm, TemplateForm } from './asset-forms.tsx';
import { AssetDetailPanel, KindBadge, StatusBadge } from './asset-detail.tsx';
import {
  dueBadgeVariant,
  dueState,
  isoDateLabel,
  money,
  nextDueOf,
  portfolioStats,
  todayIsoDate,
} from './assets-model.ts';
import { AssetSummary } from './asset-summary.tsx';
import { DepreciationOverview } from './depreciation.tsx';
import { InvestmentForm, InvestmentPlan } from './investments.tsx';
import { TextField } from './form-kit.tsx';
import { InventoryTab } from './inventory.tsx';

const CREATE_FORM_ID = 'facility-assets-create-form';
const ALL = 'all';

type CreatePanel =
  | { readonly kind: 'asset' }
  | { readonly kind: 'inventory' }
  | { readonly kind: 'template' }
  | { readonly kind: 'investment'; readonly investment?: Investment }
  | { readonly kind: 'followUp'; readonly inventory: Inventory; readonly item: InventoryItem };

const csvCell = (value: string) => (/[";\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
const csvAmount = (minor: number | undefined) =>
  minor === undefined ? '' : (minor / 100).toFixed(2).replace('.', ',');

/** Downloads the currently filtered register as CSV (semicolon separated, UTF-8 BOM for Excel). */
const exportCsv = (rows: readonly Asset[], k: (key: string) => string) => {
  const header = [
    k('fields.inventoryNumber'),
    k('fields.name'),
    k('fields.kind'),
    k('fields.category'),
    k('fields.location'),
    k('fields.status'),
    k('fields.acquisitionDate'),
    k('fields.acquisitionValue'),
    k('fields.currentValue'),
    k('columns.nextDue'),
    k('fields.responsible'),
  ];
  const lines = rows.map((asset) =>
    [
      asset.inventoryNumber,
      asset.name,
      k(`kind.${asset.kind ?? 'equipment'}`),
      asset.category,
      asset.location?.label ?? '',
      isActiveAsset(asset) ? k('status.active') : k(`disposal.${asset.disposal?.kind ?? 'retirement'}`),
      asset.acquisitionDate ?? '',
      csvAmount(asset.acquisitionValueMinor),
      csvAmount(asset.currentValueMinor),
      nextDueOf(asset)?.nextDueOn ?? '',
      asset.responsible ?? '',
    ]
      .map(csvCell)
      .join(';'),
  );
  const blob = new Blob([`\uFEFF${[header.map(csvCell).join(';'), ...lines].join('\r\n')}`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `provoz-majetek-${todayIsoDate()}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
};

const AssetsView = () => {
  const { language: currentLanguage, t } = useModernI18n();
  const language = currentLanguage === 'en' ? 'en' : 'cs';
  const k = (key: string, options?: Record<string, unknown>) => t(`facility-operations.assets.${key}`, options);
  const toast = useToast();
  const ops = useAgendaRecords(['assets']);
  const envelope = ops.data?.agendas.assets;
  const state: AssetsState = envelope?.state ?? { assets: [] };
  const canWrite = envelope?.canWrite === true;
  const actor = ops.data?.actorPrincipalRef;
  const today = todayIsoDate();

  const [tab, setTab] = useState('register');
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState(ALL);
  const [propertyFilter, setPropertyFilter] = useState(ALL);
  const [statusFilter, setStatusFilter] = useState('active');
  const [responsibleFilter, setResponsibleFilter] = useState(ALL);
  const [acquiredFrom, setAcquiredFrom] = useState('');
  const [acquiredTo, setAcquiredTo] = useState('');
  // Deep link from the calendar / overview: /cs/provoz/majetek?asset=<id>
  const [openId, setOpenId] = useState<string | undefined>(
    () => new URLSearchParams(globalThis.location?.search ?? '').get('asset') ?? undefined,
  );
  const [panel, setPanel] = useState<CreatePanel | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (command: OpsCommand, successKey: string): Promise<boolean> => {
    setBusy(true);
    const outcome = await ops.run(command);
    setBusy(false);
    if (outcome.ok) {
      toast.create({ title: k(successKey), type: 'success' });
      return true;
    }
    toast.create({ title: t(`facility-operations.common.errors.${outcome.reason}`), type: 'error' });
    return false;
  };

  const query = foldSearchText(search.trim());
  // Every filter except the status filter: the KPI cards and the value summary follow these rows.
  // Archived (test) records leave the register, KPI cards and filters; only the „Archivované“ view shows them.
  const showArchived = statusFilter === 'archived';
  const registered = state.assets.filter((asset) => isArchivedAsset(asset) === showArchived);
  const scoped = registered.filter(
    (asset) =>
      (kindFilter === ALL || (asset.kind ?? 'equipment') === kindFilter) &&
      (propertyFilter === ALL || asset.propertyId === propertyFilter) &&
      (responsibleFilter === ALL || (asset.responsible ?? '') === responsibleFilter) &&
      (acquiredFrom === '' || (asset.acquisitionDate !== undefined && asset.acquisitionDate >= acquiredFrom)) &&
      (acquiredTo === '' || (asset.acquisitionDate !== undefined && asset.acquisitionDate <= acquiredTo)) &&
      (query === '' ||
        foldSearchText(
          `${asset.inventoryNumber} ${asset.name} ${asset.category} ${asset.location?.label ?? ''} ${asset.serialNumber ?? ''} ${asset.responsible ?? ''}`,
        ).includes(query)),
  );
  const filtered = scoped.length !== registered.length;
  const stats = portfolioStats({ ...state, assets: scoped }, today);
  const responsibles = [
    ...new Set(registered.flatMap((asset) => (asset.responsible === undefined ? [] : [asset.responsible]))),
  ].toSorted((left, right) => left.localeCompare(right, 'cs'));
  const properties = [
    ...new Map(
      registered.flatMap((asset) =>
        asset.propertyId === undefined || asset.location === undefined
          ? []
          : [
              [
                asset.propertyId,
                asset.location.label.split(' › ')[0]?.replace(/ \([^)]*\)$/, '') ?? asset.propertyId,
              ] as const,
            ],
      ),
    ).entries(),
  ];
  const rows = scoped.filter(
    (asset) => statusFilter === ALL || showArchived || (statusFilter === 'active') === isActiveAsset(asset),
  );
  const propertyName = (asset: Asset) =>
    properties.find(([id]) => id === asset.propertyId)?.[1] ?? k('summary.noProperty');
  const opened = state.assets.find((asset) => asset.id === openId);
  const dues = upcomingServiceDue(state);

  const columns: ColumnDef<Asset>[] = [
    {
      accessorKey: 'inventoryNumber',
      cell: (info) => <span className="whitespace-nowrap tabular-nums">{info.row.original.inventoryNumber}</span>,
      header: k('fields.inventoryNumber'),
      meta: { width: 125 },
    },
    {
      accessorKey: 'name',
      cell: (info) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{info.row.original.name}</span>
          <span className="truncate text-fg-secondary text-xs">{info.row.original.category}</span>
        </span>
      ),
      header: k('fields.name'),
      meta: { width: 240 },
    },
    {
      cell: (info) => <KindBadge asset={info.row.original} />,
      header: k('fields.kind'),
      id: 'kind',
      meta: { width: 100 },
    },
    {
      cell: (info) => (
        <span className="block truncate text-sm">
          {info.row.original.location?.label.replace(/ \([^)]*\)$/, '') ?? k('notProvided')}
        </span>
      ),
      header: k('fields.location'),
      id: 'location',
      meta: { width: 180 },
    },
    {
      cell: (info) => (
        <span className="tabular-nums">{money(info.row.original.acquisitionValueMinor, k('notProvided'))}</span>
      ),
      header: k('columns.acquisitionValue'),
      id: 'acquisition',
      meta: { align: 'end', width: 135 },
    },
    {
      cell: (info) => (
        <span className="font-medium tabular-nums">{money(info.row.original.currentValueMinor, k('notProvided'))}</span>
      ),
      header: k('columns.currentValue'),
      id: 'current',
      meta: { align: 'end', width: 135 },
    },
    {
      cell: (info) => {
        if (!isActiveAsset(info.row.original)) {
          return <StatusBadge asset={info.row.original} />;
        }
        const next = nextDueOf(info.row.original);
        if (next?.nextDueOn === undefined) {
          return <span className="text-fg-secondary text-xs">{k('due.none')}</span>;
        }
        const due = dueState(next.nextDueOn, today);
        return (
          <span className="flex min-w-0 flex-col items-start gap-50">
            <Badge size="sm" variant={dueBadgeVariant(due)}>
              {isoDateLabel(next.nextDueOn)}
            </Badge>
            <span
              className="text-fg-secondary text-xs"
              style={{ maxWidth: '100%', overflowWrap: 'anywhere', whiteSpace: 'normal' }}
            >
              {next.title}
            </span>
          </span>
        );
      },
      header: k('columns.nextDue'),
      id: 'nextDue',
      meta: { width: 170 },
    },
  ];

  const filterItems = (items: readonly { label: string; value: string }[]) =>
    items.map((item) => ({ displayValue: item.label, label: item.label, value: item.value }));

  const createTitle =
    panel === undefined
      ? ''
      : panel.kind === 'asset'
        ? k('actions.newAsset')
        : panel.kind === 'inventory'
          ? k('actions.newInventory')
          : panel.kind === 'template'
            ? k('actions.newTemplate')
            : panel.kind === 'investment'
              ? panel.investment === undefined
                ? k('investments.new')
                : k('investments.edit')
              : k('inventory.createFollowUp');
  const createSuccess =
    panel === undefined
      ? ''
      : panel.kind === 'asset'
        ? 'messages.created'
        : panel.kind === 'inventory'
          ? 'messages.inventoryCreated'
          : panel.kind === 'template'
            ? 'messages.templateCreated'
            : panel.kind === 'investment'
              ? 'investments.saved'
              : 'messages.followUpCreated';
  const submitCreate = (command: OpsCommand) => {
    void submit(command, createSuccess).then((ok) => {
      if (!ok) {
        return;
      }
      if (panel?.kind === 'inventory') {
        setTab('inventories');
      }
      if (panel?.kind === 'asset' && ops.data !== undefined) {
        setStatusFilter('active');
      }
      setPanel(undefined);
    });
  };

  return (
    <>
      <PageHeader
        actions={
          envelope === undefined ? undefined : (
            <>
              <Button onClick={() => exportCsv(rows, k)} size="sm" theme="borderless" variant="secondary">
                {k('actions.exportCsv')}
              </Button>
              {canWrite && (
                <>
                  <Button
                    onClick={() => setPanel({ kind: 'inventory' })}
                    size="sm"
                    theme="outlined"
                    variant="secondary"
                  >
                    {k('actions.newInventory')}
                  </Button>
                  <Button onClick={() => setPanel({ kind: 'asset' })} size="sm" variant="primary">
                    {k('actions.newAsset')}
                  </Button>
                </>
              )}
            </>
          )
        }
        description={k('description')}
        meta={
          envelope !== undefined && !canWrite ? (
            <Badge size="sm" variant="outline">
              {t('facility-operations.common.readOnly')}
            </Badge>
          ) : undefined
        }
        title={k('title')}
      />
      <AgendaGate onRetry={() => void ops.reload()} readable={envelope !== undefined} status={ops.status}>
        <StatRow>
          <StatCard
            hint={k('stats.disposedHint', { count: stats.disposed })}
            label={k('stats.active')}
            value={formatNumber(stats.active)}
          />
          <StatCard
            hint={filtered ? k('stats.filteredHint') : k('stats.allHint')}
            label={k('stats.acquisitionTotal')}
            value={formatMoney(stats.acquisitionTotal)}
          />
          <StatCard
            hint={
              stats.missingValues > 0
                ? k('stats.missingValues', { count: stats.missingValues })
                : k('stats.currentHint')
            }
            label={k('stats.currentTotal')}
            value={formatMoney(stats.currentTotal)}
          />
          <StatCard
            hint={k('stats.soonHint', { count: stats.soon })}
            label={k('stats.overdue')}
            value={formatNumber(stats.overdue)}
            {...(stats.overdue > 0 ? { delta: { trend: 'down' as const, value: k('due.overdue') } } : {})}
          />
        </StatRow>
        <Tabs onValueChange={setTab} value={tab} variant="line">
          <Tabs.List style={{ overflowX: 'auto', whiteSpace: 'nowrap' }}>
            <Tabs.Trigger style={{ flexShrink: 0, whiteSpace: 'nowrap' }} value="register">
              {k('tabs.register')}
            </Tabs.Trigger>
            <Tabs.Trigger style={{ flexShrink: 0, whiteSpace: 'nowrap' }} value="services">
              {k('tabs.services', { count: dues.length })}
            </Tabs.Trigger>
            <Tabs.Trigger style={{ flexShrink: 0, whiteSpace: 'nowrap' }} value="inventories">
              {k('tabs.inventories')}
            </Tabs.Trigger>
            <Tabs.Trigger style={{ flexShrink: 0, whiteSpace: 'nowrap' }} value="summary">
              {k('tabs.summary')}
            </Tabs.Trigger>
            <Tabs.Trigger style={{ flexShrink: 0, whiteSpace: 'nowrap' }} value="investments">
              {k('tabs.investments', { count: (state.investments ?? []).length })}
            </Tabs.Trigger>
            <Tabs.Trigger style={{ flexShrink: 0, whiteSpace: 'nowrap' }} value="depreciation">
              {k('tabs.depreciation')}
            </Tabs.Trigger>
            <Tabs.Indicator />
          </Tabs.List>
          <Tabs.Content className="flex flex-col gap-200 py-250" value="register">
            <div className="flex flex-wrap items-end gap-150">
              <div className="min-w-[16rem] flex-1">
                <Input
                  aria-label={k('filters.search')}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={k('filters.searchPlaceholder')}
                  size="md"
                  value={search}
                />
              </div>
              <div className="w-[11rem]">
                <Select
                  items={filterItems([
                    { label: k('filters.active'), value: 'active' },
                    { label: k('filters.disposed'), value: 'disposed' },
                    { label: k('filters.allStatuses'), value: ALL },
                    { label: k('filters.archived'), value: 'archived' },
                  ])}
                  label={k('filters.status')}
                  name="statusFilter"
                  onValueChange={({ value }) => setStatusFilter(value[0] ?? 'active')}
                  size="md"
                  value={[statusFilter]}
                />
              </div>
              <div className="w-[11rem]">
                <Select
                  items={filterItems([
                    { label: k('filters.allKinds'), value: ALL },
                    ...assetKinds.map((kind) => ({ label: k(`kind.${kind}`), value: kind })),
                  ])}
                  label={k('fields.kind')}
                  name="kindFilter"
                  onValueChange={({ value }) => setKindFilter(value[0] ?? ALL)}
                  size="md"
                  value={[kindFilter]}
                />
              </div>
              <div className="w-[15rem]">
                <Select
                  items={filterItems([
                    { label: k('filters.allProperties'), value: ALL },
                    ...properties.map(([id, name]) => ({ label: name, value: id })),
                  ])}
                  label={k('filters.property')}
                  name="propertyFilter"
                  onValueChange={({ value }) => setPropertyFilter(value[0] ?? ALL)}
                  size="md"
                  value={[propertyFilter]}
                />
              </div>
              <div className="w-[13rem]">
                <Select
                  items={filterItems([
                    { label: k('filters.allResponsible'), value: ALL },
                    ...responsibles.map((name) => ({ label: name, value: name })),
                  ])}
                  label={k('fields.responsible')}
                  name="responsibleFilter"
                  onValueChange={({ value }) => setResponsibleFilter(value[0] ?? ALL)}
                  size="md"
                  value={[responsibleFilter]}
                />
              </div>
              <div className="w-[10rem]">
                <TextField
                  id="assets-acquired-from"
                  label={k('filters.acquiredFrom')}
                  onChange={setAcquiredFrom}
                  type="date"
                  value={acquiredFrom}
                />
              </div>
              <div className="w-[10rem]">
                <TextField
                  id="assets-acquired-to"
                  label={k('filters.acquiredTo')}
                  onChange={setAcquiredTo}
                  type="date"
                  value={acquiredTo}
                />
              </div>
            </div>
            {filtered && (
              <p className="text-fg-secondary text-xs">{k('filters.scopedTotals', { count: scoped.length })}</p>
            )}
            <DataTable
              columns={columns}
              data={[...rows]}
              enablePagination
              enableSorting
              getRowId={(row) => row.id}
              getRowLabel={(row) => row.original.name}
              loading={false}
              onRowClick={(row) => setOpenId(row.original.id)}
              pageSizeOptions={[50, 100, 200]}
              paginationProps={{ translations: paginationTranslations }}
              size="sm"
              tableLayout="fixed"
              translations={{
                ...dataTableRowLabels,
                pageSizeLabel: k('table.pageSize'),
                rangeLabel: ({ end, start, total }) => k('table.range', { end, start, total }),
                emptyDescription:
                  statusFilter === 'disposed'
                    ? k('states.noDisposed')
                    : showArchived
                      ? k('states.noArchived')
                    : t('facility-operations.common.states.emptyDescription'),
                emptyTitle: t('facility-operations.common.states.emptyTitle'),
              }}
            />
          </Tabs.Content>
          <Tabs.Content className="flex flex-col gap-200 py-250" value="services">
            <p className="text-fg-secondary text-sm">{k('services.intro')}</p>
            <Table size="sm" variant="line">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>{k('fields.nextDueOn')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('fields.serviceTitle')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('columns.asset')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('fields.location')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('fields.responsible')}</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {dues.map((due) => {
                  const state_ = dueState(due.nextDueOn, today);
                  return (
                    <Table.Row
                      className="cursor-pointer hover:bg-surface-hover"
                      key={due.recordId}
                      onClick={() => setOpenId(due.assetId)}
                    >
                      <Table.Cell>
                        <span className="flex flex-col items-start gap-50">
                          <span className="tabular-nums">{isoDateLabel(due.nextDueOn)}</span>
                          <Badge size="sm" variant={dueBadgeVariant(state_)}>
                            {k(`due.${state_}`)}
                          </Badge>
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="flex flex-col">
                          <span className="font-medium">{due.title}</span>
                          <span className="text-fg-secondary text-xs">{k(`serviceKind.${due.kind}`)}</span>
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="flex flex-col">
                          <span>{due.assetName}</span>
                          <span className="text-fg-secondary text-xs tabular-nums">{due.inventoryNumber}</span>
                        </span>
                      </Table.Cell>
                      <Table.Cell>{due.location?.label.replace(/ \([^)]*\)$/, '') ?? k('notProvided')}</Table.Cell>
                      <Table.Cell>{due.responsible ?? k('notProvided')}</Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </Tabs.Content>
          <Tabs.Content className="py-250" value="inventories">
            <p className="mb-200 text-sm">
              {k('stats.openFollowUps')}: <strong>{formatNumber(stats.openFollowUps)}</strong>
            </p>
            <InventoryTab
              actor={actor}
              busy={busy}
              canWrite={canWrite}
              onFollowUp={(inventory, item) => setPanel({ inventory, item, kind: 'followUp' })}
              onNew={() => setPanel({ kind: 'inventory' })}
              onOpenAsset={(asset) => setOpenId(asset.id)}
              onSubmit={submit}
              state={state}
            />
          </Tabs.Content>
          <Tabs.Content className="py-250" value="summary">
            <AssetSummary
              filtered={filtered}
              k={k}
              onOpen={(asset) => setOpenId(asset.id)}
              propertyName={propertyName}
              rows={scoped}
              today={today}
            />
          </Tabs.Content>
          <Tabs.Content className="py-250" value="investments">
            <InvestmentPlan
              canWrite={canWrite}
              k={k}
              onEdit={(investment) => setPanel({ investment, kind: 'investment' })}
              onNew={() => setPanel({ kind: 'investment' })}
              propertyFilter={propertyFilter}
              state={state}
              today={today}
            />
          </Tabs.Content>
          <Tabs.Content className="py-250" value="depreciation">
            <DepreciationOverview
              canWrite={canWrite}
              onNewTemplate={() => setPanel({ kind: 'template' })}
              onOpen={(asset) => setOpenId(asset.id)}
              state={state}
            />
          </Tabs.Content>
        </Tabs>
      </AgendaGate>
      {opened !== undefined && (
        <AssetDetailPanel
          actor={actor}
          asset={opened}
          busy={busy}
          canWrite={canWrite}
          language={language}
          onClose={() => setOpenId(undefined)}
          onOpenAsset={(asset) => setOpenId(asset.id)}
          onSubmit={submit}
          state={state}
        />
      )}
      <SidePanel
        actions={
          <>
            <Button onClick={() => setPanel(undefined)} theme="outlined" variant="secondary">
              {t('facility-operations.common.cancel')}
            </Button>
            <Button form={CREATE_FORM_ID} isLoading={busy} loadingText={k('saving')} type="submit" variant="primary">
              {panel?.kind === 'asset' ? k('actions.createAsset') : k('actions.save')}
            </Button>
          </>
        }
        closeOnInteractOutside={false}
        onOpenChange={(next) => {
          if (!next) {
            setPanel(undefined);
          }
        }}
        open={panel !== undefined}
        resizeLabel={k('resize')}
        size="lg"
        title={createTitle}
      >
        {panel?.kind === 'asset' && <AssetCardForm formId={CREATE_FORM_ID} onSubmit={submitCreate} state={state} />}
        {panel?.kind === 'inventory' && (
          <InventoryCreateForm formId={CREATE_FORM_ID} onSubmit={submitCreate} state={state} />
        )}
        {panel?.kind === 'template' && <TemplateForm formId={CREATE_FORM_ID} onSubmit={submitCreate} />}
        {panel?.kind === 'investment' && (
          <InvestmentForm
            formId={CREATE_FORM_ID}
            onSubmit={submitCreate}
            state={state}
            {...(panel.investment === undefined ? {} : { investment: panel.investment })}
          />
        )}
        {panel?.kind === 'followUp' && (
          <FollowUpForm
            assetId={panel.item.assetId}
            assetName={panel.item.name}
            formId={CREATE_FORM_ID}
            inventoryId={panel.inventory.id}
            onSubmit={submitCreate}
          />
        )}
      </SidePanel>
    </>
  );
};

export const AssetsPage = () => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="facility-operations.assets.title" />
    <AssetsView />
  </AgendaFrame>
);

export default AssetsPage;
