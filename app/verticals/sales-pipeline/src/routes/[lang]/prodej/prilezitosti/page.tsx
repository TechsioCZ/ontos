import { BulkActionBar, foldSearchText, PageHeader, Toaster } from '@app/admin-ui';
import { modulePagePreload } from '@app/shared-contracts/page-data';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { useTagsFor } from '@app/tagging/components/tag-controls';
import type { TagId } from '@app/tagging/contracts/records';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { DataTableRowAction } from '@techsio/ui-kit/organisms/data-table';
import { Effect, Match, Option, Predicate, Schema } from 'effect';
import type { Dispatch, SetStateAction } from 'react';
import { useReducer, useState } from 'react';
import type { ApplyCommandResult } from '../../../../../shared/actions/apply-command.ts';
import { isOpenStage } from '../../../../../shared/model/opportunity.ts';
import type { Opportunity } from '../../../../../shared/model/opportunity.ts';
import {
  OpportunityIdSchema,
  PartyIdSchema,
} from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import csResource from '../../../../../locales/cs/sales-pipeline.json';
import enResource from '../../../../../locales/en/sales-pipeline.json';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';
import type { BulkByTagResult } from './pipeline-bulk-by-tag.tsx';
import type { FormCommand } from './pipeline-dialogs.tsx';
import type { DialogState, Target } from './pipeline-dialog-host.tsx';
import { PipelineDialogHost, ownerCommand, requestedCount, stageCommand } from './pipeline-dialog-host.tsx';
import { PipelineDetailPanel } from './pipeline-detail-panel.tsx';
import { PipelineFilters, PipelineStats } from './pipeline-filters.tsx';
import { applyPipelineCommand } from './pipeline-api.ts';
import type { PipelineCommand } from './pipeline-api.ts';
import { containsFolded, pipelineConflictKey, skipTally, sortNewestFirst } from './pipeline-model.ts';
import type { EmployeeId, OpportunityStage, SkipTally } from './pipeline-model.ts';
import {
  PipelineEmptyState,
  buildColumns,
  buildPaginationProps,
  buildTableTranslations,
  defaultColumnVisibility,
} from './pipeline-table.tsx';
import type { PipelineLookups } from './pipeline-table.tsx';
import { initialRecordsInput, pipelineRecords, usePipelineRecords } from './pipeline-records.ts';
import type { RecordsLoadError } from './pipeline-records.ts';
import type { CustomerOption, EmployeeOption, LoadState } from './pipeline-references.ts';
import { toSubjectIds, usePipelineReferences, useSubjectIdsWithTag } from './pipeline-references.ts';

const salesPipelineI18nResources = {
  cs: { 'sales-pipeline': csResource },
  en: { 'sales-pipeline': enResource },
} as const;

const K = 'sales-pipeline.pages.records';

type PartyId = typeof PartyIdSchema.Type;
type Selection = Record<string, true>;

const formToastKey = (command: FormCommand): string =>
  Match.value(command).pipe(
    Match.tag('CreateOpportunity', () => `${K}.toasts.created`),
    Match.orElse(() => `${K}.toasts.updated`),
  );

/**
 * Rows that pass search, the unassigned toggle and the tag set (`undefined` when no tag filter is set),
 * newest first.
 */
const filterRows = (
  items: readonly Opportunity[],
  search: string,
  unassignedOnly: boolean,
  tagMembers: ReadonlySet<string> | undefined,
) => {
  const query = foldSearchText(search.trim());
  return sortNewestFirst(
    items.filter(
      (item) =>
        (query === '' || containsFolded(item.title, query)) &&
        (!unassignedOnly || item.ownerEmployeeId === undefined) &&
        (tagMembers === undefined || tagMembers.has(item.id)),
    ),
  );
};

/** Ids the tag filter lets through: none while it loads or after it failed, everything when no tag is chosen. */
const tagMembersOf = (state: ReturnType<typeof useSubjectIdsWithTag>): ReadonlySet<string> | undefined => {
  if (state === undefined) {
    return undefined;
  }
  return state.status === 'ready' ? state.items : new Set<string>();
};

interface PipelineBulkBarProps {
  readonly onClear: () => void;
  readonly onOwner: () => void;
  readonly onStage: () => void;
  readonly onTags: () => void;
  readonly selectedCount: number;
}

const PipelineBulkBar = ({ onClear, onOwner, onStage, onTags, selectedCount }: PipelineBulkBarProps) => {
  const { t } = useModernI18n();
  return (
    <BulkActionBar onClear={onClear} selectedCount={selectedCount}>
      <Button icon="icon-[mdi--swap-horizontal]" onClick={onStage} size="sm" theme="outlined" variant="secondary">
        {t(`${K}.bulk.stage`)}
      </Button>
      <Button
        icon="icon-[mdi--account-arrow-right-outline]"
        onClick={onOwner}
        size="sm"
        theme="outlined"
        variant="secondary"
      >
        {t(`${K}.bulk.owner`)}
      </Button>
      <Button icon="icon-[mdi--tag-outline]" onClick={onTags} size="sm" theme="outlined" variant="secondary">
        {t(`${K}.bulk.tags`)}
      </Button>
    </BulkActionBar>
  );
};

interface PipelineTableProps {
  readonly canWrite: boolean;
  readonly conflictingFilters: boolean;
  readonly filtersActive: boolean;
  readonly hasResponse: boolean;
  readonly loadError: RecordsLoadError | undefined;
  readonly loading: boolean;
  readonly lookups: PipelineLookups;
  readonly onArchive: (opportunity: Opportunity) => void;
  readonly onClearFilters: () => void;
  readonly onCreate: () => void;
  readonly onEdit: (opportunity: Opportunity) => void;
  readonly onOpen: (opportunity: Opportunity) => void;
  readonly onOwner: (opportunity: Opportunity) => void;
  readonly onRetry: () => void;
  readonly onSelection: Dispatch<SetStateAction<Selection>>;
  readonly onStage: (opportunity: Opportunity) => void;
  readonly rows: Opportunity[];
  readonly selection: Selection;
}

const PipelineTable = ({
  canWrite,
  conflictingFilters,
  filtersActive,
  hasResponse,
  loadError,
  loading,
  lookups,
  onArchive,
  onClearFilters,
  onCreate,
  onEdit,
  onOpen,
  onOwner,
  onRetry,
  onSelection,
  onStage,
  rows,
  selection,
}: PipelineTableProps) => {
  const { t } = useModernI18n();
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>(defaultColumnVisibility);
  const writeActions: DataTableRowAction<Opportunity>[] = canWrite
    ? [
        {
          disabled: (row) => !isOpenStage(row.original.stage),
          icon: 'icon-[mdi--pencil-outline]',
          id: 'edit',
          label: t(`${K}.actions.edit`),
          onAction: (row) => onEdit(row.original),
        },
        {
          icon: 'icon-[mdi--swap-horizontal]',
          id: 'stage',
          label: t(`${K}.actions.changeStage`),
          onAction: (row) => onStage(row.original),
        },
        {
          disabled: (row) => !isOpenStage(row.original.stage),
          icon: 'icon-[mdi--account-arrow-right-outline]',
          id: 'owner',
          label: t(`${K}.actions.assignOwner`),
          onAction: (row) => onOwner(row.original),
        },
        {
          disabled: (row) => isOpenStage(row.original.stage),
          icon: 'icon-[mdi--archive-outline]',
          id: 'archive',
          label: t(`${K}.actions.archive`),
          onAction: (row) => onArchive(row.original),
        },
      ]
    : [];
  const rowActions: DataTableRowAction<Opportunity>[] = [
    {
      icon: 'icon-[mdi--open-in-new]',
      id: 'detail',
      label: 'Otevřít detail',
      onAction: (row) => onOpen(row.original),
    },
    ...writeActions,
  ];
  return (
    <DataTable
      // The row-selection column must stay first, so it is pinned ahead of the title.
      columnPinning={{ end: [], start: ['__select', 'title'] }}
      columns={buildColumns(t, lookups)}
      columnVisibility={columnVisibility}
      data={rows}
      enableColumnFilters={false}
      enableColumnPinning
      enableColumnVisibility
      enablePagination
      enableRowSelection={canWrite}
      enableSorting
      getRowId={(row) => row.id}
      getRowLabel={(row) => row.original.title}
      loading={loading}
      loadingRowCount={10}
      maxHeight="calc(100dvh - 22rem)"
      onColumnVisibilityChange={setColumnVisibility}
      onRowClick={(row) => onOpen(row.original)}
      onRowSelectionChange={onSelection}
      pageSizeOptions={[50, 100, 200]}
      paginationProps={buildPaginationProps(t)}
      renderEmpty={() => (
        <PipelineEmptyState
          canWrite={canWrite}
          conflictingFilters={conflictingFilters}
          filtersActive={filtersActive}
          hasResponse={hasResponse}
          loadError={loadError}
          onClearFilters={onClearFilters}
          onCreate={onCreate}
          onRetry={onRetry}
        />
      )}
      rowActions={rowActions}
      rowSelection={selection}
      size="sm"
      stickyHeader
      tableLayout="fixed"
      translations={buildTableTranslations(t)}
    />
  );
};

/** Any server or local filter narrows the rows. */
const hasActiveFilters = (state: {
  readonly customerFilter: PartyId | '';
  readonly ownerFilter: EmployeeId | '';
  readonly search: string;
  readonly stageFilter: OpportunityStage | '';
  readonly tagFilter: TagId | null;
  readonly unassignedOnly: boolean;
}): boolean =>
  state.search.trim() !== '' ||
  state.stageFilter !== '' ||
  state.ownerFilter !== '' ||
  state.customerFilter !== '' ||
  state.tagFilter !== null ||
  state.unassignedOnly;

const activeEmployeesOf = (state: LoadState<readonly EmployeeOption[]>): readonly EmployeeOption[] =>
  state.status === 'ready' ? state.items.filter((item) => item.active) : [];

const buildLookups = ({
  customers,
  employees,
  tagsBySubject,
}: {
  readonly customers: LoadState<readonly CustomerOption[]>;
  readonly employees: LoadState<readonly EmployeeOption[]>;
  readonly tagsBySubject: PipelineLookups['tagsBySubject'];
}): PipelineLookups => ({
  customerById: new Map<string, CustomerOption>(
    customers.status === 'ready' ? customers.items.map((item) => [item.id, item]) : [],
  ),
  customersReady: customers.status === 'ready',
  employeeById: new Map<string, EmployeeOption>(
    employees.status === 'ready' ? employees.items.map((item) => [item.id, item]) : [],
  ),
  employeesReady: employees.status === 'ready',
  tagsBySubject,
});

type PipelineViewFilters = Parameters<typeof hasActiveFilters>[0];
const emptyViewFilters: PipelineViewFilters = {
  customerFilter: '',
  ownerFilter: '',
  search: '',
  stageFilter: '',
  tagFilter: null,
  unassignedOnly: false,
};
const reduceViewFilters = (current: PipelineViewFilters, patch: Partial<PipelineViewFilters>): PipelineViewFilters => ({
  ...current,
  ...patch,
});

/** `Přeskočeno: 2 (uzavřené: 1, beze změny: 1)`, or nothing when every requested id changed. */
const skippedText = (tally: SkipTally, t: ReturnType<typeof useModernI18n>['t']): string | undefined => {
  const reasons = [
    ['closed', tally.closed],
    ['invalidTransition', tally.invalidTransition],
    ['notFound', tally.notFound],
    ['other', tally.other],
  ] as const;
  const parts = reasons.flatMap(([reason, total]) =>
    total > 0 ? [t(`${K}.toasts.skipReasons.${reason}`, { total })] : [],
  );
  return tally.total === 0 ? undefined : t(`${K}.toasts.skipped`, { reasons: parts.join(', '), total: tally.total });
};

/** Executes a pipeline command and keeps its pending/error state with the dialog that invoked it. */
const usePipelineCommands = (revision: number, reload: () => void) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string>();
  const runCommand = (command: PipelineCommand, onDone: (result: ApplyCommandResult) => void) => {
    setBusy(true);
    setDialogError(undefined);
    void browserRuntime.runPromise(
      applyPipelineCommand(command, revision).pipe(
        Effect.match({
          onFailure: (error) => {
            setBusy(false);
            const message = Match.value(error).pipe(
              Match.tag('ApplyCommandActionConflictProblem', (problem) => t(pipelineConflictKey(problem.code))),
              Match.tag('ApplyCommandActionForbiddenProblem', () => t(`${K}.errors.forbidden`)),
              Match.orElse(() => t(`${K}.errors.generic`)),
            );
            setDialogError(message);
            if (Predicate.isTagged(command, 'ArchiveOpportunity')) {
              toaster.create({ title: message, type: 'error' });
            }
            reload();
          },
          onSuccess: (result) => {
            setBusy(false);
            onDone(result);
            reload();
          },
        }),
      ),
    );
  };
  return { busy, dialogError, runCommand, setDialogError };
};

const RecordsPageContent = ({
  initialOpportunityId,
  initialPartyId,
  invalidFilter,
  legalEntityId,
}: {
  readonly initialOpportunityId: string | undefined;
  readonly initialPartyId: PartyId | undefined;
  readonly invalidFilter: boolean;
  readonly legalEntityId: string;
}) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const { customers, employees, products } = usePipelineReferences();
  const [tagVersion, setTagVersion] = useState(0);
  const [filters, updateFilters] = useReducer(reduceViewFilters, {
    ...emptyViewFilters,
    customerFilter: initialPartyId ?? '',
  });
  const { customerFilter, ownerFilter, search, stageFilter, tagFilter, unassignedOnly } = filters;
  const setSearch = (next: string) => updateFilters({ search: next });
  const setStageFilter = (next: OpportunityStage | '') => updateFilters({ stageFilter: next });
  const setOwnerFilter = (next: EmployeeId | '') => updateFilters({ ownerFilter: next });
  const setCustomerFilter = (next: PartyId | '') => updateFilters({ customerFilter: next });
  const setTagFilter = (next: TagId | null) => updateFilters({ tagFilter: next });
  const setUnassignedOnly = (next: boolean) => updateFilters({ unassignedOnly: next });
  const [selection, setSelection] = useState<Selection>({});
  const [dialog, setDialog] = useState<DialogState>();
  const [detailId, setDetailId] = useState<string | undefined>(initialOpportunityId);
  const { loadError, pending, reload, response } = usePipelineRecords(
    { customer: customerFilter, legalEntityId, owner: ownerFilter, stage: stageFilter },
    !invalidFilter,
  );
  const canWrite = response?.canWrite === true;
  const revision = response?.revision ?? 0;
  const { busy, dialogError, runCommand, setDialogError } = usePipelineCommands(revision, reload);

  const items = response?.items ?? [];
  const { refetch: refetchTags, tagsBySubject } = useTagsFor('opportunity', toSubjectIds(items.map((item) => item.id)));
  const tagState = useSubjectIdsWithTag('opportunity', tagFilter, tagVersion);
  const rows = filterRows(items, search, unassignedOnly, tagMembersOf(tagState));
  const selectedIds = rows.flatMap((row) => (selection[row.id] === true ? [row.id] : []));
  const filtersActive = hasActiveFilters({
    customerFilter,
    ownerFilter,
    search,
    stageFilter,
    tagFilter,
    unassignedOnly,
  });

  const activeEmployees = activeEmployeesOf(employees);
  const lookups = buildLookups({ customers, employees, tagsBySubject });
  const { customerById } = lookups;
  const unknownCustomer = t(`${K}.create.unknownCustomer`);
  const customerLabel = (partyId: string) => customerById.get(partyId)?.name ?? unknownCustomer;

  const clearFilters = () => updateFilters(emptyViewFilters);

  const openDialog = (next: DialogState) => {
    setDialogError(undefined);
    setDialog(next);
  };
  const closeDialog = () => {
    setDialogError(undefined);
    setDialog(undefined);
  };

  const submitForm = (command: FormCommand) =>
    runCommand(command, () => {
      closeDialog();
      toaster.create({ title: t(formToastKey(command)), type: 'success' });
    });

  const submitStage = (stage: OpportunityStage, note: string | undefined) => {
    if (dialog?.kind !== 'stage') {
      return;
    }
    const { target } = dialog;
    runCommand(stageCommand(target, stage, note), (result) => {
      closeDialog();
      if (target.mode === 'bulk') {
        setSelection({});
      }
      toaster.create({
        description: skippedText(skipTally(requestedCount(target), result), t),
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
    runCommand(ownerCommand(target, owner), (result) => {
      closeDialog();
      if (target.mode === 'bulk') {
        setSelection({});
      }
      toaster.create({
        description: skippedText(skipTally(requestedCount(target), result), t),
        title: owner === null ? t(`${K}.toasts.ownerRemoved`) : t(`${K}.toasts.ownerAssigned`),
        type: 'success',
      });
    });
  };

  const finishBulkByTag = (result: BulkByTagResult) => {
    closeDialog();
    setSelection({});
    reload();
    toaster.create({
      description: skippedText(result.skipped, t),
      title: t(`${K}.toasts.bulkChanged`, { changed: result.changed, skipped: result.skipped.total }),
      type: 'success',
    });
  };

  const finishBulkTags = () => {
    setTagVersion((version) => version + 1);
    refetchTags();
    reload();
  };

  const openCreate = () => openDialog({ kind: 'form' });
  const openStage = (target: Target) => openDialog({ kind: 'stage', target });
  const openOwner = (target: Target) => openDialog({ kind: 'owner', target });

  if (invalidFilter) {
    return <StatusText status="error">{t(`${K}.errors.invalidFilter`)}</StatusText>;
  }

  return (
    <>
      <UltramodernRouteHead />
      <Toaster />
      <PageHeader
        actions={
          canWrite ? (
            <>
              <Button
                disabled={response === undefined}
                onClick={() => openDialog({ kind: 'bulkByTag' })}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                {t(`${K}.bulkByTag.title`)}
              </Button>
              <Button
                disabled={response === undefined}
                icon="icon-[mdi--plus]"
                onClick={openCreate}
                size="sm"
                variant="primary"
              >
                {t(`${K}.newOpportunity`)}
              </Button>
            </>
          ) : undefined
        }
        description={t(`${K}.description`)}
        title={t(`${K}.title`)}
      />

      <PipelineStats indicators={response?.indicators} />

      <PipelineFilters
        customer={customerFilter}
        customers={customers}
        employees={activeEmployees}
        onCustomer={setCustomerFilter}
        onOwner={setOwnerFilter}
        onSearch={setSearch}
        onStage={setStageFilter}
        onTag={setTagFilter}
        onUnassignedOnly={setUnassignedOnly}
        owner={ownerFilter}
        search={search}
        stage={stageFilter}
        tag={tagFilter}
        unassignedOnly={unassignedOnly}
      />
      {tagState?.status === 'error' && (
        <StatusText showIcon status="error">
          {t(`${K}.filters.tagFailed`)}
        </StatusText>
      )}

      {canWrite && (
        <PipelineBulkBar
          onClear={() => setSelection({})}
          onOwner={() => openOwner({ ids: selectedIds, mode: 'bulk' })}
          onStage={() =>
            openStage({
              ids: selectedIds,
              mode: 'bulk',
              stages: rows.flatMap((row) => (selection[row.id] === true ? [row.stage] : [])),
            })
          }
          onTags={() => openDialog({ ids: selectedIds, kind: 'tags' })}
          selectedCount={selectedIds.length}
        />
      )}

      <PipelineTable
        canWrite={canWrite}
        conflictingFilters={ownerFilter !== '' && unassignedOnly}
        filtersActive={filtersActive}
        hasResponse={response !== undefined}
        loadError={loadError}
        loading={(response === undefined && loadError === undefined) || pending || tagState?.status === 'loading'}
        lookups={lookups}
        onArchive={(opportunity) => openDialog({ kind: 'archive', opportunity })}
        onClearFilters={clearFilters}
        onCreate={openCreate}
        onEdit={(opportunity) => openDialog({ kind: 'form', opportunity })}
        onOpen={(opportunity) => setDetailId(opportunity.id)}
        onOwner={(opportunity) => openOwner({ mode: 'row', opportunity })}
        onRetry={reload}
        onSelection={setSelection}
        onStage={(opportunity) => openStage({ mode: 'row', opportunity })}
        rows={rows}
        selection={selection}
      />

      <PipelineDetailPanel
        canWrite={canWrite}
        lookups={lookups}
        onClose={() => setDetailId(undefined)}
        onEdit={(opportunity) => {
          setDetailId(undefined);
          openDialog({ kind: 'form', opportunity });
        }}
        onStage={(opportunity) => {
          setDetailId(undefined);
          openStage({ mode: 'row', opportunity });
        }}
        opportunity={detailId === undefined ? undefined : items.find((item) => item.id === detailId)}
      />

      <PipelineDialogHost
        activeEmployees={activeEmployees}
        busy={busy}
        customerLabel={customerLabel}
        customers={customers}
        dialog={dialog}
        employees={employees}
        error={dialogError}
        onArchiveSubmit={(opportunity) => {
          runCommand({ _tag: 'ArchiveOpportunity', id: opportunity.id }, () => {
            closeDialog();
            setSelection({});
            toaster.create({ title: t(`${K}.toasts.archived`), type: 'success' });
          });
        }}
        onBulkByTagDone={finishBulkByTag}
        onBulkTagsDone={finishBulkTags}
        onClose={closeDialog}
        onFormSubmit={submitForm}
        onOwnerSubmit={submitOwner}
        onStageSubmit={submitStage}
        products={products}
      />
    </>
  );
};

const customerSearchSchema = Schema.Struct({
  opportunityId: Schema.optional(OpportunityIdSchema),
  partyId: Schema.optional(PartyIdSchema),
});

/** The Shell prepares the opening records read before it reveals the page. */
export const preloadPage = modulePagePreload((props) =>
  initialRecordsInput(props).pipe(
    Option.match({ onNone: () => Effect.void, onSome: (input) => pipelineRecords.preload(input) }),
  ),
);

/** Inside the Shell the page gets the person's context; on its own it reads without a legal entity key. */
export const RecordsPage = ({ context }: Partial<ModulePageProps>) => {
  const location = useRouterState({ select: (state) => state.location.href });
  const search = useRouterState({
    select: (state) => {
      const rawSearch: unknown = state.location.search;
      return Schema.decodeUnknownOption(Schema.toEncoded(customerSearchSchema))(rawSearch).pipe(
        Option.map((value) => ({ opportunityId: value.opportunityId, partyId: value.partyId ?? null })),
        Option.getOrElse(() => null),
      );
    },
  });
  const requested =
    search === null
      ? Option.none()
      : Schema.decodeOption(customerSearchSchema)(search.partyId === null ? {} : { partyId: search.partyId });
  return (
    <FederatedI18nBoundary
      defaultNamespace="sales-pipeline"
      fallbackLanguage="en"
      resources={salesPipelineI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent
        initialOpportunityId={search?.opportunityId}
        initialPartyId={Option.getOrUndefined(requested)?.partyId}
        invalidFilter={Option.isNone(requested)}
        key={location}
        legalEntityId={context?.legalEntityId ?? ''}
      />
    </FederatedI18nBoundary>
  );
};

export default RecordsPage;
