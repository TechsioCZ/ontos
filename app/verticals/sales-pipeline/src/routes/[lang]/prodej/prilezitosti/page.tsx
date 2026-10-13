import { BulkActionBar, PageHeader } from '@app/admin-ui';
import { useTagsFor } from '@app/tagging/components/tag-controls';
import type { TagId } from '@app/tagging/contracts/records';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Toaster, useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import { Effect, Match } from 'effect';
import type { Dispatch, SetStateAction } from 'react';
import { useState } from 'react';
import type { ApplyCommandResult } from '../../../../../shared/actions/apply-command.ts';
import type { Opportunity } from '../../../../../shared/model/opportunity.ts';
import type { PartyIdSchema } from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import csResource from '../../../../../locales/cs/sales-pipeline.json';
import enResource from '../../../../../locales/en/sales-pipeline.json';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import '../../../index.css';
import type { BulkByTagResult } from './pipeline-bulk-by-tag.tsx';
import type { FormCommand } from './pipeline-dialogs.tsx';
import type { DialogState, Target } from './pipeline-dialog-host.tsx';
import { PipelineDialogHost, ownerCommand, requestedCount, stageCommand } from './pipeline-dialog-host.tsx';
import { PipelineFilters, PipelineStats } from './pipeline-filters.tsx';
import { applyPipelineCommand } from './pipeline-api.ts';
import type { PipelineCommand } from './pipeline-api.ts';
import { skipTally, sortNewestFirst } from './pipeline-model.ts';
import type { EmployeeId, OpportunityStage, SkipTally } from './pipeline-model.ts';
import {
  PipelineEmptyState,
  buildColumns,
  buildTableTranslations,
  defaultColumnVisibility,
} from './pipeline-table.tsx';
import type { PipelineLookups } from './pipeline-table.tsx';
import { usePipelineRecords } from './pipeline-records.ts';
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
  const query = search.trim().toLocaleLowerCase('cs-CZ');
  return sortNewestFirst(
    items.filter(
      (item) =>
        (query === '' || item.title.toLocaleLowerCase('cs-CZ').includes(query)) &&
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
  readonly filtersActive: boolean;
  readonly hasResponse: boolean;
  readonly loadError: RecordsLoadError | undefined;
  readonly loading: boolean;
  readonly lookups: PipelineLookups;
  readonly onClearFilters: () => void;
  readonly onCreate: () => void;
  readonly onEdit: (opportunity: Opportunity) => void;
  readonly onOwner: (opportunity: Opportunity) => void;
  readonly onRetry: () => void;
  readonly onSelection: Dispatch<SetStateAction<Selection>>;
  readonly onStage: (opportunity: Opportunity) => void;
  readonly rows: Opportunity[];
  readonly selection: Selection;
}

const PipelineTable = ({
  canWrite,
  filtersActive,
  hasResponse,
  loadError,
  loading,
  lookups,
  onClearFilters,
  onCreate,
  onEdit,
  onOwner,
  onRetry,
  onSelection,
  onStage,
  rows,
  selection,
}: PipelineTableProps) => {
  const { t } = useModernI18n();
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>(defaultColumnVisibility);
  return (
    <DataTable
      columnPinning={{ end: [], start: ['title'] }}
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
      onRowSelectionChange={onSelection}
      pageSizeOptions={[50, 100, 200]}
      renderEmpty={() => (
        <PipelineEmptyState
          canWrite={canWrite}
          filtersActive={filtersActive}
          hasResponse={hasResponse}
          loadError={loadError}
          onClearFilters={onClearFilters}
          onCreate={onCreate}
          onRetry={onRetry}
        />
      )}
      rowActions={
        canWrite
          ? [
              {
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
                icon: 'icon-[mdi--account-arrow-right-outline]',
                id: 'owner',
                label: t(`${K}.actions.assignOwner`),
                onAction: (row) => onOwner(row.original),
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

const RecordsPageContent = () => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const { customers, employees, products } = usePipelineReferences();
  const [reloadKey, setReloadKey] = useState(0);
  const [tagVersion, setTagVersion] = useState(0);
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<OpportunityStage | ''>('');
  const [ownerFilter, setOwnerFilter] = useState<EmployeeId | ''>('');
  const [customerFilter, setCustomerFilter] = useState<PartyId | ''>('');
  const [tagFilter, setTagFilter] = useState<TagId | null>(null);
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [selection, setSelection] = useState<Selection>({});
  const [dialog, setDialog] = useState<DialogState>();
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string>();

  const { loadError, response } = usePipelineRecords(
    { customer: customerFilter, owner: ownerFilter, stage: stageFilter },
    reloadKey,
  );
  const canWrite = response?.canWrite === true;
  const revision = response?.revision ?? 0;
  const reload = () => setReloadKey((key) => key + 1);

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

  const clearFilters = () => {
    setSearch('');
    setStageFilter('');
    setOwnerFilter('');
    setCustomerFilter('');
    setTagFilter(null);
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

  const runCommand = (command: PipelineCommand, onDone: (result: ApplyCommandResult) => void) => {
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
            onDone(result);
            reload();
          },
        }),
      ),
    );
  };

  /** `Přeskočeno: 2 (uzavřené: 1, beze změny: 1)`, or nothing when every requested id changed. */
  const skippedText = (tally: SkipTally): string | undefined => {
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
        description: skippedText(skipTally(requestedCount(target), result)),
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
        description: skippedText(skipTally(requestedCount(target), result)),
        title: t(`${K}.toasts.ownerAssigned`),
        type: 'success',
      });
    });
  };

  const finishBulkByTag = (result: BulkByTagResult) => {
    closeDialog();
    setSelection({});
    reload();
    toaster.create({
      description: skippedText(result.skipped),
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
          onStage={() => openStage({ ids: selectedIds, mode: 'bulk' })}
          onTags={() => openDialog({ ids: selectedIds, kind: 'tags' })}
          selectedCount={selectedIds.length}
        />
      )}

      <PipelineTable
        canWrite={canWrite}
        filtersActive={filtersActive}
        hasResponse={response !== undefined}
        loadError={loadError}
        loading={(response === undefined && loadError === undefined) || tagState?.status === 'loading'}
        lookups={lookups}
        onClearFilters={clearFilters}
        onCreate={openCreate}
        onEdit={(opportunity) => openDialog({ kind: 'form', opportunity })}
        onOwner={(opportunity) => openOwner({ mode: 'row', opportunity })}
        onRetry={reload}
        onSelection={setSelection}
        onStage={(opportunity) => openStage({ mode: 'row', opportunity })}
        rows={rows}
        selection={selection}
      />

      <PipelineDialogHost
        activeEmployees={activeEmployees}
        busy={busy}
        customerLabel={customerLabel}
        customers={customers}
        dialog={dialog}
        employees={employees}
        error={dialogError}
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
