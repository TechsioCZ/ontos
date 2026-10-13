import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Toaster, useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef, DataTableTranslations } from '@techsio/ui-kit/organisms/data-table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { DateTime, Effect, Match, Option, Schema } from 'effect';
import { useEffect, useState } from 'react';
import type { OpportunityIndicators, RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { Opportunity } from '../../../../../shared/model/opportunity.ts';
import csResource from '../../../../../locales/cs/sales-pipeline.json';
import enResource from '../../../../../locales/en/sales-pipeline.json';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';
import { applyPipelineCommand, loadPipeline, recordsFilters } from './pipeline-api.ts';
import type { PipelineCommand } from './pipeline-api.ts';
import { CreateOpportunityDialog, OwnerDialog, StageDialog } from './pipeline-dialogs.tsx';
import type { CreateCommand } from './pipeline-dialogs.tsx';
import type { EmployeeId, OpportunityStage } from './pipeline-model.ts';
import {
  customerLabel,
  employeeOptions,
  findEmployee,
  formatCalendarDate,
  formatDateTime,
  formatMoney,
  formatPercent,
  isOpportunityStage,
  opportunityCount,
  opportunityStages,
  ownerLabel,
} from './pipeline-model.ts';
import { BulkActionBar, EmptyState, PageHeader, StageBadge, StatCard, StatRow } from './pipeline-ui.tsx';

const salesPipelineI18nResources = {
  cs: { 'sales-pipeline': csResource },
  en: { 'sales-pipeline': enResource },
} as const;

const K = 'sales-pipeline.pages.records';
const ALL = '__all__';
const UNASSIGNED = '__unassigned__';

type Translate = ReturnType<typeof useModernI18n>['t'];
type OpportunityId = Opportunity['id'];
const LoadErrorSchema = Schema.Literals(['forbidden', 'unavailable']);
type LoadError = typeof LoadErrorSchema.Type;

/** Dialog target: one row from the row menu, or the bulk selection. */
type Target = { mode: 'row'; opportunity: Opportunity } | { ids: readonly OpportunityId[]; mode: 'bulk' };

type DialogState = { kind: 'create' } | { kind: 'stage'; target: Target } | { kind: 'owner'; target: Target };

const requestedCount = (target: Target) => (target.mode === 'row' ? 1 : target.ids.length);

const targetIds = (target: Target): OpportunityId[] =>
  target.mode === 'row' ? [target.opportunity.id] : [...target.ids];

const stageCommand = (target: Target, stage: OpportunityStage, note: string | undefined): PipelineCommand => {
  if (target.mode === 'bulk') {
    return { _tag: 'BulkUpdateOpportunities', ids: targetIds(target), patch: { stage } };
  }
  const base = { _tag: 'ChangeOpportunityStage' as const, id: target.opportunity.id, toStage: stage };
  return note === undefined ? base : { ...base, note };
};

const ownerCommand = (target: Target, owner: EmployeeId | null): PipelineCommand => {
  const ownerOption: Option.Option<EmployeeId> = owner === null ? Option.none() : Option.some(owner);
  if (target.mode === 'bulk') {
    return { _tag: 'BulkUpdateOpportunities', ids: targetIds(target), patch: { ownerEmployeeId: ownerOption } };
  }
  return { _tag: 'AssignOpportunity', id: target.opportunity.id, ownerEmployeeId: ownerOption };
};

const parseStageFilter = (value: string | undefined): OpportunityStage | '' => (isOpportunityStage(value) ? value : '');

const parseOwnerFilter = (value: string | undefined): EmployeeId | '' => {
  if (value === undefined || value === ALL) {
    return '';
  }
  return findEmployee(value) ?? '';
};

/** Search by title and the unassigned toggle narrow the rows; stage and owner are server filters. */
const filterRows = (items: readonly Opportunity[], search: string, unassignedOnly: boolean) => {
  const query = search.trim().toLocaleLowerCase('cs-CZ');
  return items.filter(
    (item) =>
      (query === '' || item.title.toLocaleLowerCase('cs-CZ').includes(query)) &&
      (!unassignedOnly || item.ownerEmployeeId === undefined),
  );
};

const buildColumns = (t: Translate): ColumnDef<Opportunity>[] => [
  {
    accessorKey: 'title',
    cell: (info) => <span className="block truncate font-medium">{info.row.original.title}</span>,
    header: t(`${K}.columns.title`),
    meta: { type: 'string', width: 220 },
  },
  {
    accessorKey: 'partyId',
    cell: (info) => <span className="block truncate">{customerLabel(info.row.original.partyId)}</span>,
    header: t(`${K}.columns.customer`),
    meta: { type: 'string', width: 170 },
  },
  {
    accessorFn: (row) => row.ownerEmployeeId ?? '',
    cell: (info) => {
      const owner = info.row.original.ownerEmployeeId;
      return owner === undefined ? (
        <span className="text-fg-secondary">{t(`${K}.owner.none`)}</span>
      ) : (
        <span className="block truncate">{ownerLabel(owner)}</span>
      );
    },
    header: t(`${K}.columns.owner`),
    id: 'owner',
    meta: { type: 'string', width: 150 },
  },
  {
    accessorKey: 'stage',
    cell: (info) => {
      const { stage } = info.row.original;
      return <StageBadge label={t(`sales-pipeline.status.opportunity.${stage}`)} stage={stage} />;
    },
    header: t(`${K}.columns.stage`),
    meta: {
      options: opportunityStages.map((stage) => ({
        label: t(`sales-pipeline.status.opportunity.${stage}`),
        value: stage,
      })),
      type: 'enum',
      width: 130,
    },
  },
  {
    accessorKey: 'probability',
    cell: (info) => <span className="tabular-nums">{formatPercent(info.getValue<number>() / 100)}</span>,
    header: t(`${K}.columns.probability`),
    meta: { align: 'end', type: 'number', width: 110 },
  },
  {
    accessorKey: 'amountMinor',
    cell: (info) => <span className="tabular-nums">{formatMoney(info.getValue<number>())}</span>,
    header: t(`${K}.columns.amount`),
    meta: { align: 'end', type: 'number', width: 130 },
  },
  {
    accessorKey: 'expectedCloseDate',
    cell: (info) => formatCalendarDate(info.getValue<string>()),
    header: t(`${K}.columns.expectedClose`),
    meta: { type: 'date', width: 140 },
  },
  {
    accessorFn: (row) => DateTime.toEpochMillis(row.updatedAt),
    cell: (info) => formatDateTime(info.row.original.updatedAt),
    header: t(`${K}.columns.updatedAt`),
    id: 'updatedAt',
    meta: { type: 'date', width: 150 },
  },
  {
    enableSorting: false,
    header: t(`${K}.columns.tags`),
    id: 'tags',
    meta: { type: 'string', width: 140 },
    // Tag chips arrive with the tagging lane; the slot stays empty until then.
    cell: () => <span className="text-fg-secondary">—</span>,
  },
];

const buildTableTranslations = (t: Translate): DataTableTranslations => ({
  actionsLabel: t('sales-pipeline.table.actionsLabel'),
  clearSearchLabel: t('sales-pipeline.table.clearSearchLabel'),
  columnsLabel: t('sales-pipeline.table.columnsLabel'),
  editingLabel: t('sales-pipeline.table.editingLabel'),
  emptyDescription: t('sales-pipeline.table.emptyDescription'),
  emptyTitle: t('sales-pipeline.table.emptyTitle'),
  filtersLabel: t('sales-pipeline.table.filtersLabel'),
  loadingLabel: t('sales-pipeline.table.loadingLabel'),
  pageSizeLabel: t('sales-pipeline.table.pageSizeLabel'),
  rangeLabel: ({ end, start, total }) => `${start}–${end} z ${total}`,
  reorderLabel: t('sales-pipeline.table.reorderLabel'),
  requiredLabel: t('sales-pipeline.table.requiredLabel'),
  searchButtonLabel: t('sales-pipeline.table.searchButtonLabel'),
  searchLabel: t('sales-pipeline.table.searchLabel'),
  searchPlaceholder: t('sales-pipeline.table.searchPlaceholder'),
  selectAllLabel: t('sales-pipeline.table.selectAllLabel'),
  selectionLabel: t('sales-pipeline.table.selectionLabel'),
});

const PipelineStats = ({ indicators }: { indicators: OpportunityIndicators | undefined }) => {
  const { t } = useModernI18n();
  return (
    <StatRow>
      <StatCard
        hint={indicators === undefined ? undefined : opportunityCount(indicators.openCount)}
        label={t(`${K}.stats.open`)}
        value={indicators === undefined ? '—' : formatMoney(indicators.openValueMinor)}
      />
      <StatCard
        label={t(`${K}.stats.weighted`)}
        value={indicators === undefined ? '—' : formatMoney(indicators.weightedValueMinor)}
      />
      <StatCard
        hint={indicators === undefined ? undefined : opportunityCount(indicators.wonCount)}
        label={t(`${K}.stats.won`)}
        value={indicators === undefined ? '—' : formatMoney(indicators.wonValueMinor)}
      />
      <StatCard
        label={t(`${K}.stats.winRate`)}
        value={
          indicators === undefined
            ? '—'
            : Option.match(indicators.winRate, { onNone: () => '—', onSome: formatPercent })
        }
      />
    </StatRow>
  );
};

interface PipelineFiltersProps {
  onOwner: (owner: EmployeeId | '') => void;
  onSearch: (search: string) => void;
  onStage: (stage: OpportunityStage | '') => void;
  onUnassignedOnly: (unassigned: boolean) => void;
  owner: EmployeeId | '';
  search: string;
  stage: OpportunityStage | '';
  unassignedOnly: boolean;
}

const PipelineFilters = ({
  onOwner,
  onSearch,
  onStage,
  onUnassignedOnly,
  owner,
  search,
  stage,
  unassignedOnly,
}: PipelineFiltersProps) => {
  const { t } = useModernI18n();
  const stageItems = [
    { label: t(`${K}.filters.allStages`), value: ALL },
    ...opportunityStages.map((candidate) => ({
      label: t(`sales-pipeline.status.opportunity.${candidate}`),
      value: candidate,
    })),
  ];
  const ownerItems = [
    { label: t(`${K}.filters.allOwners`), value: ALL },
    ...employeeOptions().map((employee) => ({ label: employee.fullName, value: employee.id })),
  ];
  const assignmentItems = [
    { label: t(`${K}.filters.allOpportunities`), value: ALL },
    { label: t(`${K}.filters.unassignedOnly`), value: UNASSIGNED },
  ];

  return (
    <div className="flex flex-wrap items-end gap-200">
      <div className="w-64 min-w-0">
        <FormInput
          id="pipeline-search"
          label={t(`${K}.filters.searchLabel`)}
          name="search"
          onChange={(event) => onSearch(event.target.value)}
          placeholder={t(`${K}.filters.search`)}
          value={search}
        />
      </div>
      <div className="w-52">
        <SelectTemplate
          items={stageItems}
          label={t(`${K}.filters.stage`)}
          name="stage"
          onValueChange={(details) => onStage(parseStageFilter(details.value[0]))}
          size="sm"
          value={[stage === '' ? ALL : stage]}
        />
      </div>
      <div className="w-52">
        <SelectTemplate
          items={ownerItems}
          label={t(`${K}.filters.owner`)}
          name="owner"
          onValueChange={(details) => onOwner(parseOwnerFilter(details.value[0]))}
          size="sm"
          value={[owner === '' ? ALL : owner]}
        />
      </div>
      <div className="w-52">
        <SelectTemplate
          items={assignmentItems}
          label={t(`${K}.filters.assignment`)}
          name="assignment"
          onValueChange={(details) => onUnassignedOnly(details.value[0] === UNASSIGNED)}
          size="sm"
          value={[unassignedOnly ? UNASSIGNED : ALL]}
        />
      </div>
    </div>
  );
};

interface PipelineEmptyStateProps {
  canWrite: boolean;
  filtersActive: boolean;
  hasResponse: boolean;
  loadError: LoadError | undefined;
  onClearFilters: () => void;
  onCreate: () => void;
  onRetry: () => void;
}

/** Load error, no results and first use each get their own message and next step. */
const PipelineEmptyState = ({
  canWrite,
  filtersActive,
  hasResponse,
  loadError,
  onClearFilters,
  onCreate,
  onRetry,
}: PipelineEmptyStateProps) => {
  const { t } = useModernI18n();
  if (loadError !== undefined) {
    return (
      <EmptyState
        action={
          <Button onClick={onRetry} size="sm" theme="outlined" variant="secondary">
            {t(`${K}.retry`)}
          </Button>
        }
        description={t(`${K}.retryDescription`)}
        title={t(loadError === 'forbidden' ? `${K}.forbidden` : `${K}.unavailable`)}
      />
    );
  }
  if (!hasResponse) {
    return null;
  }
  if (filtersActive) {
    return (
      <EmptyState
        action={
          <Button onClick={onClearFilters} size="sm" theme="outlined" variant="secondary">
            {t(`${K}.clearFilters`)}
          </Button>
        }
        title={t(`${K}.noResults`)}
      />
    );
  }
  return (
    <EmptyState
      action={
        canWrite ? (
          <Button onClick={onCreate} size="sm" theme="outlined" variant="secondary">
            {t(`${K}.newOpportunity`)}
          </Button>
        ) : undefined
      }
      description={t(`${K}.emptyDescription`)}
      title={t(`${K}.emptyTitle`)}
    />
  );
};

interface PipelineDialogsProps {
  busy: boolean;
  dialog: DialogState | undefined;
  onClose: () => void;
  onCreate: (command: CreateCommand) => void;
  onOwner: (owner: EmployeeId | null) => void;
  onStage: (stage: OpportunityStage, note: string | undefined) => void;
  serverError: string | undefined;
}

const PipelineDialogs = ({ busy, dialog, onClose, onCreate, onOwner, onStage, serverError }: PipelineDialogsProps) => {
  const { t } = useModernI18n();
  if (dialog === undefined) {
    return null;
  }
  if (dialog.kind === 'create') {
    return (
      <CreateOpportunityDialog
        busy={busy}
        onOpenChange={(open) => {
          if (!open) {
            onClose();
          }
        }}
        onSubmit={onCreate}
        serverError={serverError}
      />
    );
  }
  const { target } = dialog;
  const description =
    target.mode === 'row' ? target.opportunity.title : t(`${K}.bulk.selected`, { total: target.ids.length });
  if (dialog.kind === 'stage') {
    return (
      <StageDialog
        busy={busy}
        currentStage={target.mode === 'row' ? target.opportunity.stage : undefined}
        description={description}
        onOpenChange={(open) => {
          if (!open) {
            onClose();
          }
        }}
        onSubmit={onStage}
        serverError={serverError}
        showNote={target.mode === 'row'}
      />
    );
  }
  return (
    <OwnerDialog
      busy={busy}
      currentOwner={target.mode === 'row' ? target.opportunity.ownerEmployeeId : undefined}
      description={description}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      onSubmit={onOwner}
      serverError={serverError}
    />
  );
};

const RecordsPageContent = () => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [response, setResponse] = useState<RecordsResponse>();
  const [loadError, setLoadError] = useState<LoadError>();
  const [reloadKey, setReloadKey] = useState(0);
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<OpportunityStage | ''>('');
  const [ownerFilter, setOwnerFilter] = useState<EmployeeId | ''>('');
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [selection, setSelection] = useState<Record<string, true>>({});
  const [dialog, setDialog] = useState<DialogState>();
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string>();

  const canWrite = response?.canWrite === true;
  const revision = response?.revision ?? 0;
  const reload = () => setReloadKey((key) => key + 1);

  useEffect(() => {
    let current = true;
    void browserRuntime.runPromise(
      loadPipeline(recordsFilters(stageFilter, ownerFilter), reloadKey).pipe(
        Effect.match({
          onFailure: (error) => {
            if (current) {
              setLoadError(
                Match.value(error).pipe(
                  Match.tag('RecordsForbiddenProblem', () => 'forbidden' as const),
                  Match.orElse(() => 'unavailable' as const),
                ),
              );
            }
          },
          onSuccess: (result) => {
            if (current) {
              setLoadError(undefined);
              setResponse(result);
            }
          },
        }),
      ),
    );
    return () => {
      current = false;
    };
  }, [ownerFilter, reloadKey, stageFilter]);

  const rows = filterRows(response?.items ?? [], search, unassignedOnly);
  const selectedIds = rows.flatMap((row) => (selection[row.id] === true ? [row.id] : []));
  const filtersActive = search.trim() !== '' || stageFilter !== '' || ownerFilter !== '' || unassignedOnly;

  const clearFilters = () => {
    setSearch('');
    setStageFilter('');
    setOwnerFilter('');
    setUnassignedOnly(false);
  };
  const openDialog = (next: DialogState) => {
    setDialogError(undefined);
    setDialog(next);
  };
  const closeDialog = () => {
    setDialogError(undefined);
    setDialog(undefined);
  };

  const runCommand = (command: PipelineCommand, onDone: (touched: number) => void) => {
    setBusy(true);
    setDialogError(undefined);
    void browserRuntime.runPromise(
      applyPipelineCommand(command, revision).pipe(
        Effect.match({
          onFailure: (error) => {
            setBusy(false);
            setDialogError(
              Match.value(error).pipe(
                Match.tag('ApplyCommandActionConflictProblem', () => t(`${K}.errors.conflict`)),
                Match.tag('ApplyCommandActionForbiddenProblem', () => t(`${K}.errors.forbidden`)),
                Match.orElse(() => t(`${K}.errors.generic`)),
              ),
            );
            reload();
          },
          onSuccess: (result) => {
            setBusy(false);
            onDone(result.opportunities.length);
            reload();
          },
        }),
      ),
    );
  };

  const skippedText = (requested: number, touched: number) =>
    requested > touched ? t(`${K}.toasts.skipped`, { total: requested - touched }) : undefined;

  const submitCreate = (command: CreateCommand) =>
    runCommand(command, () => {
      closeDialog();
      toaster.create({ description: command.title, title: t(`${K}.toasts.created`), type: 'success' });
    });

  const submitStage = (stage: OpportunityStage, note: string | undefined) => {
    if (dialog?.kind !== 'stage') {
      return;
    }
    const { target } = dialog;
    runCommand(stageCommand(target, stage, note), (touched) => {
      closeDialog();
      if (target.mode === 'bulk') {
        setSelection({});
      }
      toaster.create({
        description: skippedText(requestedCount(target), touched),
        title: t(`${K}.toasts.stageChanged`),
        type: 'success',
      });
    });
  };

  const submitOwner = (owner: EmployeeId | null) => {
    if (dialog?.kind !== 'owner') {
      return;
    }
    const { target } = dialog;
    runCommand(ownerCommand(target, owner), (touched) => {
      closeDialog();
      if (target.mode === 'bulk') {
        setSelection({});
      }
      toaster.create({
        description: skippedText(requestedCount(target), touched),
        title: t(`${K}.toasts.ownerAssigned`),
        type: 'success',
      });
    });
  };

  const openCreate = () => openDialog({ kind: 'create' });
  const openStage = (target: Target) => openDialog({ kind: 'stage', target });
  const openOwner = (target: Target) => openDialog({ kind: 'owner', target });

  return (
    <>
      <UltramodernRouteHead />
      <Toaster />
      <PageHeader
        actions={
          canWrite ? (
            <Button
              disabled={response === undefined}
              icon="icon-[mdi--plus]"
              onClick={openCreate}
              size="sm"
              variant="primary"
            >
              {t(`${K}.newOpportunity`)}
            </Button>
          ) : undefined
        }
        description={t(`${K}.description`)}
        title={t(`${K}.title`)}
      />

      <PipelineStats indicators={response?.indicators} />

      <PipelineFilters
        onOwner={setOwnerFilter}
        onSearch={setSearch}
        onStage={setStageFilter}
        onUnassignedOnly={setUnassignedOnly}
        owner={ownerFilter}
        search={search}
        stage={stageFilter}
        unassignedOnly={unassignedOnly}
      />

      <BulkActionBar
        clearLabel={t(`${K}.bulk.clear`)}
        label={t(`${K}.bulk.selected`, { total: selectedIds.length })}
        onClear={() => setSelection({})}
        visible={canWrite && selectedIds.length > 0}
      >
        <Button
          icon="icon-[mdi--swap-horizontal]"
          onClick={() => openStage({ ids: selectedIds, mode: 'bulk' })}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          {t(`${K}.bulk.stage`)}
        </Button>
        <Button
          icon="icon-[mdi--account-arrow-right-outline]"
          onClick={() => openOwner({ ids: selectedIds, mode: 'bulk' })}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          {t(`${K}.bulk.owner`)}
        </Button>
      </BulkActionBar>

      <DataTable
        columnPinning={{ end: [], start: ['title'] }}
        columns={buildColumns(t)}
        data={rows}
        enableColumnPinning
        enablePagination
        enableRowSelection={canWrite}
        enableSorting
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.original.title}
        loading={response === undefined && loadError === undefined}
        loadingRowCount={10}
        maxHeight="calc(100dvh - 22rem)"
        onRowSelectionChange={setSelection}
        pageSizeOptions={[50, 100, 200]}
        renderEmpty={() => (
          <PipelineEmptyState
            canWrite={canWrite}
            filtersActive={filtersActive}
            hasResponse={response !== undefined}
            loadError={loadError}
            onClearFilters={clearFilters}
            onCreate={openCreate}
            onRetry={reload}
          />
        )}
        rowActions={
          canWrite
            ? [
                {
                  icon: 'icon-[mdi--swap-horizontal]',
                  id: 'stage',
                  label: t(`${K}.actions.changeStage`),
                  onAction: (row) => openStage({ mode: 'row', opportunity: row.original }),
                },
                {
                  icon: 'icon-[mdi--account-arrow-right-outline]',
                  id: 'owner',
                  label: t(`${K}.actions.assignOwner`),
                  onAction: (row) => openOwner({ mode: 'row', opportunity: row.original }),
                },
              ]
            : []
        }
        rowSelection={selection}
        size="sm"
        stickyHeader
        tableLayout="fixed"
        translations={buildTableTranslations(t)}
      />

      <PipelineDialogs
        busy={busy}
        dialog={dialog}
        onClose={closeDialog}
        onCreate={submitCreate}
        onOwner={submitOwner}
        onStage={submitStage}
        serverError={dialogError}
      />
    </>
  );
};

export const RecordsPage = () => {
  const location = useRouterState({ select: (state) => state.location.href });
  return (
    <FederatedI18nBoundary
      defaultNamespace="sales-pipeline"
      fallbackLanguage="en"
      resources={salesPipelineI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent key={location} />
    </FederatedI18nBoundary>
  );
};

export default RecordsPage;
