import { langOf } from '../../../../ui/ops-agenda/ui-bits.tsx';
import { Effect, Match, Option, Schema } from 'effect';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
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
import type { CellContext, ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { createContext, useContext, useState } from 'react';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type { Asset, AssetsState, Inventory, InventoryItem, Investment } from '../../../../../shared/domain/assets.ts';
import { assetKinds, isActiveAsset, isArchivedAsset, upcomingServiceDue } from '../../../../../shared/domain/assets.ts';
import { AgendaFrame, AgendaGate } from '../../../../ui/agenda-frame.tsx';
import { preloadAgendaRecords, useAgendaRecords } from '../../../../ui/use-agenda.ts';
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
const KIND_LABEL = 'fields.kind';
const LOCATION_LABEL = 'fields.location';
const RESPONSIBLE_LABEL = 'fields.responsible';
const MISSING_LABEL = 'notProvided';
const AssetQuerySchema = Schema.toCodecJson(Schema.URLSearchParams);

type CreatePanel =
  | { readonly kind: 'asset' }
  | { readonly kind: 'inventory' }
  | { readonly kind: 'template' }
  | { readonly investment?: Investment; readonly kind: 'investment' }
  | { readonly inventory: Inventory; readonly item: InventoryItem; readonly kind: 'followUp' };

const csvCell = (value: string) => (/[";\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
const csvAmount = (minor: number | undefined) =>
  minor === undefined ? '' : (minor / 100).toFixed(2).replace('.', ',');

/** Downloads the currently filtered register as CSV (semicolon separated, UTF-8 BOM for Excel). */
const exportCsv = (rows: readonly Asset[], k: (key: string) => string) => {
  const header = [
    k('fields.inventoryNumber'),
    k('fields.name'),
    k(KIND_LABEL),
    k('fields.category'),
    k(LOCATION_LABEL),
    k('fields.status'),
    k('fields.acquisitionDate'),
    k('fields.acquisitionValue'),
    k('fields.currentValue'),
    k('columns.nextDue'),
    k(RESPONSIBLE_LABEL),
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

const AssetTodayContext = createContext('');

const useAssetLabel = () => {
  const { t } = useModernI18n();
  return (key: string, options?: Parameters<typeof t>[1]) => t(`facility-operations.assets.${key}`, options);
};

const AssetNumberCell = (info: CellContext<Asset>) => (
  <span className="whitespace-nowrap tabular-nums">{info.row.original.inventoryNumber}</span>
);

const AssetNameCell = (info: CellContext<Asset>) => (
  <span className="flex min-w-0 flex-col">
    <span className="truncate font-medium">{info.row.original.name}</span>
    <span className="truncate text-fg-secondary text-xs">{info.row.original.category}</span>
  </span>
);

const AssetKindCell = (info: CellContext<Asset>) => <KindBadge asset={info.row.original} />;

const AssetLocationCell = (info: CellContext<Asset>) => {
  const k = useAssetLabel();
  return (
    <span className="block truncate text-sm">
      {info.row.original.location?.label.replace(/ \([^)]*\)$/u, '') ?? k(MISSING_LABEL)}
    </span>
  );
};

const AssetAcquisitionCell = (info: CellContext<Asset>) => {
  const k = useAssetLabel();
  return <span className="tabular-nums">{money(info.row.original.acquisitionValueMinor, k(MISSING_LABEL))}</span>;
};

const AssetCurrentCell = (info: CellContext<Asset>) => {
  const k = useAssetLabel();
  return (
    <span className="font-medium tabular-nums">{money(info.row.original.currentValueMinor, k(MISSING_LABEL))}</span>
  );
};

const AssetNextDueCell = (info: CellContext<Asset>) => {
  const today = useContext(AssetTodayContext);
  const k = useAssetLabel();
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
};

const filterItems = (items: readonly { label: string; value: string }[]) =>
  items.map((item) => ({ displayValue: item.label, label: item.label, value: item.value }));

const createPanelLabels = (panel: CreatePanel | undefined, k: ReturnType<typeof useAssetLabel>) => {
  if (panel === undefined) {
    return { success: '', title: '' };
  }
  return Match.value(panel).pipe(
    Match.when({ kind: 'asset' }, () => ({ success: 'messages.created', title: k('actions.newAsset') })),
    Match.when({ kind: 'inventory' }, () => ({
      success: 'messages.inventoryCreated',
      title: k('actions.newInventory'),
    })),
    Match.when({ kind: 'template' }, () => ({ success: 'messages.templateCreated', title: k('actions.newTemplate') })),
    Match.when({ kind: 'investment' }, (value) => ({
      success: 'investments.saved',
      title: k(value.investment === undefined ? 'investments.new' : 'investments.edit'),
    })),
    Match.when({ kind: 'followUp' }, () => ({
      success: 'messages.followUpCreated',
      title: k('inventory.createFollowUp'),
    })),
    Match.exhaustive,
  );
};

const emptyRegisterDescription = (
  statusFilter: string,
  k: ReturnType<typeof useAssetLabel>,
  t: ReturnType<typeof useModernI18n>['t'],
) => {
  if (statusFilter === 'disposed') {
    return k('states.noDisposed');
  }
  return statusFilter === 'archived' ? k('states.noArchived') : t('facility-operations.common.states.emptyDescription');
};

const filterScopedAssets = (
  assets: readonly Asset[],
  {
    acquiredFrom,
    acquiredTo,
    kindFilter,
    propertyFilter,
    query,
    responsibleFilter,
  }: {
    readonly acquiredFrom: string;
    readonly acquiredTo: string;
    readonly kindFilter: string;
    readonly propertyFilter: string;
    readonly query: string;
    readonly responsibleFilter: string;
  },
) =>
  assets.filter(
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

const submitAssetCommand = Effect.fn('FacilityOperations.submitAssetCommand')(function* submitAssetCommand(
  context: {
    readonly k: ReturnType<typeof useAssetLabel>;
    readonly ops: Pick<ReturnType<typeof useAgendaRecords>, 'run'>;
    readonly setBusy: (busy: boolean) => void;
    readonly t: ReturnType<typeof useModernI18n>['t'];
    readonly toast: ReturnType<typeof useToast>;
  },
  command: OpsCommand,
  successKey: string,
) {
  context.setBusy(true);
  const outcome = yield* context.ops.run(command).pipe(Effect.ensuring(Effect.sync(() => context.setBusy(false))));
  if (outcome.ok) {
    context.toast.create({ title: context.k(successKey), type: 'success' });
    return true;
  }
  context.toast.create({ title: context.t(`facility-operations.common.errors.${outcome.reason}`), type: 'error' });
  return false;
});

const useAssetsViewModel = () => {
  const { language: currentLanguage, t } = useModernI18n();
  const language = langOf(currentLanguage);
  const k = useAssetLabel();
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
  const [openId, setOpenId] = useState<string | undefined>(() =>
    Schema.decodeOption(AssetQuerySchema)(globalThis.location?.search ?? '').pipe(
      Option.map((params) => params.get('asset') ?? undefined),
      Option.getOrUndefined,
    ),
  );
  const [panel, setPanel] = useState<CreatePanel | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = (command: OpsCommand, successKey: string) =>
    submitAssetCommand({ k, ops, setBusy, t, toast }, command, successKey);

  const query = foldSearchText(search.trim());
  // Every filter except the status filter: the KPI cards and the value summary follow these rows.
  // Archived (test) records leave the register, KPI cards and filters; only the „Archivované“ view shows them.
  const showArchived = statusFilter === 'archived';
  const registered = state.assets.filter((asset) => isArchivedAsset(asset) === showArchived);
  const scoped = filterScopedAssets(registered, {
    acquiredFrom,
    acquiredTo,
    kindFilter,
    propertyFilter,
    query,
    responsibleFilter,
  });
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
                asset.location.label.split(' › ')[0]?.replace(/ \([^)]*\)$/u, '') ?? asset.propertyId,
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
      cell: AssetNumberCell,
      header: k('fields.inventoryNumber'),
      meta: { width: 125 },
    },
    {
      accessorKey: 'name',
      cell: AssetNameCell,
      header: k('fields.name'),
      meta: { width: 240 },
    },
    {
      cell: AssetKindCell,
      header: k(KIND_LABEL),
      id: 'kind',
      meta: { width: 100 },
    },
    {
      cell: AssetLocationCell,
      header: k(LOCATION_LABEL),
      id: 'location',
      meta: { width: 180 },
    },
    {
      cell: AssetAcquisitionCell,
      header: k('columns.acquisitionValue'),
      id: 'acquisition',
      meta: { align: 'end', width: 135 },
    },
    {
      cell: AssetCurrentCell,
      header: k('columns.currentValue'),
      id: 'current',
      meta: { align: 'end', width: 135 },
    },
    {
      cell: AssetNextDueCell,
      header: k('columns.nextDue'),
      id: 'nextDue',
      meta: { width: 170 },
    },
  ];

  const { success: createSuccess, title: createTitle } = createPanelLabels(panel, k);
  const submitCreate = (command: OpsCommand): void => {
    void browserRuntime.runPromise(
      submit(command, createSuccess).pipe(
        Effect.tap((ok) =>
          Effect.sync(() => {
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
          }),
        ),
      ),
    );
  };

  return {
    acquiredFrom,
    acquiredTo,
    actor,
    busy,
    canWrite,
    columns,
    createTitle,
    dues,
    envelope,
    filtered,
    k,
    kindFilter,
    language,
    opened,
    ops,
    panel,
    properties,
    propertyFilter,
    propertyName,
    responsibleFilter,
    responsibles,
    rows,
    scoped,
    search,
    setAcquiredFrom,
    setAcquiredTo,
    setKindFilter,
    setOpenId,
    setPanel,
    setPropertyFilter,
    setResponsibleFilter,
    setSearch,
    setStatusFilter,
    setTab,
    state,
    stats,
    statusFilter,
    submit,
    submitCreate,
    t,
    tab,
    today,
  };
};

type AssetsViewModel = ReturnType<typeof useAssetsViewModel>;

const AssetsHeader = ({ vm }: { readonly vm: AssetsViewModel }) => {
  const { canWrite, envelope, k, rows, setPanel, t } = vm;
  return (
    <PageHeader
      actions={
        envelope === undefined ? undefined : (
          <>
            <Button onClick={() => exportCsv(rows, k)} size="sm" theme="borderless" variant="secondary">
              {k('actions.exportCsv')}
            </Button>
            {canWrite && (
              <>
                <Button onClick={() => setPanel({ kind: 'inventory' })} size="sm" theme="outlined" variant="secondary">
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
  );
};

const AssetsStatistics = ({ vm }: { readonly vm: AssetsViewModel }) => {
  const { filtered, k, stats } = vm;
  return (
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
          stats.missingValues > 0 ? k('stats.missingValues', { count: stats.missingValues }) : k('stats.currentHint')
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
  );
};

const AssetRegister = ({ vm }: { readonly vm: AssetsViewModel }) => {
  const {
    acquiredFrom,
    acquiredTo,
    columns,
    filtered,
    k,
    kindFilter,
    properties,
    propertyFilter,
    responsibleFilter,
    responsibles,
    rows,
    scoped,
    search,
    setAcquiredFrom,
    setAcquiredTo,
    setKindFilter,
    setOpenId,
    setPropertyFilter,
    setResponsibleFilter,
    setSearch,
    setStatusFilter,
    statusFilter,
    t,
    today,
  } = vm;
  return (
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
            label={k(KIND_LABEL)}
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
            label={k(RESPONSIBLE_LABEL)}
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
      {filtered && <p className="text-fg-secondary text-xs">{k('filters.scopedTotals', { count: scoped.length })}</p>}
      <AssetTodayContext value={today}>
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
            emptyDescription: emptyRegisterDescription(statusFilter, k, t),
            emptyTitle: t('facility-operations.common.states.emptyTitle'),
            pageSizeLabel: k('table.pageSize'),
            rangeLabel: ({ end, start, total }) => k('table.range', { end, start, total }),
          }}
        />
      </AssetTodayContext>
    </Tabs.Content>
  );
};

const AssetsServices = ({ vm }: { readonly vm: AssetsViewModel }) => {
  const { dues, k, setOpenId, today } = vm;
  return (
    <Tabs.Content className="flex flex-col gap-200 py-250" value="services">
      <p className="text-fg-secondary text-sm">{k('services.intro')}</p>
      <Table size="sm" variant="line">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>{k('fields.nextDueOn')}</Table.ColumnHeader>
            <Table.ColumnHeader>{k('fields.serviceTitle')}</Table.ColumnHeader>
            <Table.ColumnHeader>{k('columns.asset')}</Table.ColumnHeader>
            <Table.ColumnHeader>{k(LOCATION_LABEL)}</Table.ColumnHeader>
            <Table.ColumnHeader>{k(RESPONSIBLE_LABEL)}</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {dues.map((due) => {
            const serviceDueState = dueState(due.nextDueOn, today);
            return (
              <Table.Row
                className="cursor-pointer hover:bg-surface-hover"
                key={due.recordId}
                onClick={() => setOpenId(due.assetId)}
              >
                <Table.Cell>
                  <span className="flex flex-col items-start gap-50">
                    <span className="tabular-nums">{isoDateLabel(due.nextDueOn)}</span>
                    <Badge size="sm" variant={dueBadgeVariant(serviceDueState)}>
                      {k(`due.${serviceDueState}`)}
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
                <Table.Cell>{due.location?.label.replace(/ \([^)]*\)$/u, '') ?? k(MISSING_LABEL)}</Table.Cell>
                <Table.Cell>{due.responsible ?? k(MISSING_LABEL)}</Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table>
    </Tabs.Content>
  );
};

const AssetsTabs = ({ vm }: { readonly vm: AssetsViewModel }) => {
  const {
    actor,
    busy,
    canWrite,
    dues,
    filtered,
    k,
    propertyFilter,
    propertyName,
    scoped,
    setOpenId,
    setPanel,
    setTab,
    state,
    stats,
    submit,
    tab,
    today,
  } = vm;
  return (
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
      <AssetRegister vm={vm} />
      <AssetsServices vm={vm} />
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
  );
};

const AssetsCreatePanel = ({ vm }: { readonly vm: AssetsViewModel }) => {
  const { busy, createTitle, k, panel, setPanel, state, submitCreate, t } = vm;
  return (
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
  );
};

const AssetsView = () => {
  const vm = useAssetsViewModel();
  const { actor, busy, canWrite, envelope, language, opened, ops, setOpenId, state, submit } = vm;
  return (
    <>
      <AssetsHeader vm={vm} />
      <AgendaGate
        onRetry={() => {
          void browserRuntime.runPromise(ops.reload());
        }}
        readable={envelope !== undefined}
        status={ops.status}
      >
        <AssetsStatistics vm={vm} />
        <AssetsTabs vm={vm} />
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
      <AssetsCreatePanel vm={vm} />
    </>
  );
};

export const AssetsPage = () => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="facility-operations.assets.title" />
    <AssetsView />
  </AgendaFrame>
);

/** The Shell awaits this before it reveals the page, so the first render already has the assets agenda. */
export const preloadPage = preloadAgendaRecords(['assets']);
export default AssetsPage;
