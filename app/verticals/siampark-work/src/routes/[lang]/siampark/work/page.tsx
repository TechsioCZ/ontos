import { EmptyState, PageHeader, StatCard, StatRow } from '@app/admin-ui';
import { listCustomers } from '@app/party-registry/api/client';
import { listOpportunities } from '@app/sales-pipeline/clients/records';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { listEmployees } from '@app/workforce/clients/records';
import type { Employee } from '@app/workforce/contracts/records';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { Toaster, useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import { Effect, Match, Option, Random, Schema } from 'effect';
import type { Types } from 'effect';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useEffect, useState } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import type { WorkCommand } from '../../../../../shared/actions/apply-command.ts';
import { EmployeeIdSchema } from '../../../../../shared/apis/records.ts';
import type { RecordsResponse, Task } from '../../../../../shared/apis/records.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { buildTaskColumns } from './tasks-columns.tsx';
import { TaskBulkBar, TaskFilterBar } from './tasks-filters.tsx';
import { TaskFormDialog } from './task-form-dialog.tsx';
import type { TaskFormSubmission } from './task-form-dialog.tsx';
import {
  TaskTabSchema,
  doneThisWeek,
  employeeIdOf,
  filterTasks,
  initialTaskFilters,
  overdueCount,
  todayIsoDate,
  unassignedOpenCount,
} from './tasks-model.ts';
import type { CustomerOption, OpportunityOption, TaskFilters, TaskTab } from './tasks-model.ts';
import csResource from '../../../../../locales/cs/siampark-work.json';
import enResource from '../../../../../locales/en/siampark-work.json';
import '../../../index.css';

const siamparkWorkI18nResources = {
  cs: { 'siampark-work': csResource },
  en: { 'siampark-work': enResource },
} as const;

const key = 'siampark-work.pages.records';
const NONE = 'none';
const ALL = 'all';
const count = new Intl.NumberFormat('cs-CZ');
const decodeEmployeeId = Schema.decodeUnknownOption(EmployeeIdSchema);

type EditFields = Types.Mutable<
  Pick<
    Extract<WorkCommand, { readonly _tag: 'CreateTask' }>,
    'assigneeEmployeeId' | 'description' | 'dueDate' | 'opportunityId' | 'partyId' | 'priority' | 'title'
  >
>;
const LoadStateSchema = Schema.Literals(['loading', 'ready', 'error', 'forbidden']);
type LoadState = typeof LoadStateSchema.Type;
type Editor = { readonly mode: 'create' } | { readonly mode: 'edit'; readonly task: Task };
type CommandOutcome =
  | { readonly ok: true; readonly results: readonly { readonly outcome: 'changed' | 'skipped' }[] }
  | { readonly message: string; readonly ok: false };

const requestId = Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
  Effect.map(([first, second]) => `siampark-work:${first}:${second}`),
);

const formatCount = (value: number | undefined) => (value === undefined ? '—' : count.format(value));

interface RecordsSetters {
  readonly setLoadState: (state: LoadState) => void;
  readonly setRecords: (records: RecordsResponse) => void;
}

interface EmployeeSetters {
  readonly setEmployees: (employees: readonly Employee[]) => void;
  readonly setEmployeesFailed: (failed: boolean) => void;
}

// Module-scope loaders take the state setters as arguments, so the mount effect needs no dependencies.
const loadRecords = ({ setLoadState, setRecords }: RecordsSetters) => {
  browserRuntime.runFork(
    requestId.pipe(
      Effect.flatMap((id) => executeRecords({}, id)),
      Effect.match({
        onFailure: (error) =>
          setLoadState(
            Match.value(error).pipe(
              Match.tag('RecordsForbiddenProblem', () => 'forbidden' as const),
              Match.orElse(() => 'error' as const),
            ),
          ),
        onSuccess: (result) => {
          setRecords(result);
          setLoadState('ready');
        },
      }),
    ),
  );
};

const loadEmployees = ({ setEmployees, setEmployeesFailed }: EmployeeSetters) => {
  browserRuntime.runFork(
    listEmployees().pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.logWarning('Employee list unavailable.', error).pipe(
            Effect.andThen(Effect.sync(() => setEmployeesFailed(true))),
          ),
        onSuccess: (items) =>
          Effect.sync(() => {
            setEmployees(items);
            setEmployeesFailed(false);
          }),
      }),
    ),
  );
};

interface ReferenceSetters {
  readonly setCustomers: (customers: readonly CustomerOption[]) => void;
  readonly setOpportunities: (opportunities: readonly OpportunityOption[]) => void;
  readonly setReferenceFailed: (failed: boolean) => void;
}

// Names for the table and the pickers. A failed load leaves the ids visible as muted placeholders.
const loadCustomerNames = ({ setCustomers, setReferenceFailed }: ReferenceSetters) => {
  browserRuntime.runFork(
    listCustomers().pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.logWarning('Customer list unavailable.', error).pipe(
            Effect.andThen(Effect.sync(() => setReferenceFailed(true))),
          ),
        onSuccess: (items) => Effect.sync(() => setCustomers(items)),
      }),
    ),
  );
};

const loadOpportunityNames = ({ setOpportunities, setReferenceFailed }: ReferenceSetters) => {
  browserRuntime.runFork(
    requestId.pipe(
      Effect.flatMap((id) => listOpportunities({}, id)),
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.logWarning('Opportunity list unavailable.', error).pipe(
            Effect.andThen(Effect.sync(() => setReferenceFailed(true))),
          ),
        onSuccess: (result) => Effect.sync(() => setOpportunities(result.items)),
      }),
    ),
  );
};

const EmptyActionButton = ({ label, onClick }: { readonly label: string; readonly onClick: () => void }) => (
  <Button onClick={onClick} size="sm" theme="outlined" variant="secondary">
    {label}
  </Button>
);

const TaskEmptyState = ({
  canWrite,
  filtersActive,
  hasRecords,
  loadState,
  onClear,
  onCreate,
  onRetry,
  tab,
}: {
  readonly canWrite: boolean;
  readonly filtersActive: boolean;
  readonly hasRecords: boolean;
  readonly loadState: LoadState;
  readonly onClear: () => void;
  readonly onCreate: () => void;
  readonly onRetry: () => void;
  readonly tab: TaskTab;
}) => {
  const { t } = useModernI18n();
  if (loadState === 'forbidden') {
    return <EmptyState title={t(`${key}.forbidden`)} />;
  }
  if (loadState === 'error' && !hasRecords) {
    return (
      <EmptyState
        action={<EmptyActionButton label={t(`${key}.retry`)} onClick={onRetry} />}
        description={t(`${key}.errorDescription`)}
        title={t(`${key}.unavailable`)}
      />
    );
  }
  if (filtersActive) {
    return (
      <EmptyState
        action={<EmptyActionButton label={t(`${key}.filters.clear`)} onClick={onClear} />}
        title={t(`${key}.noResults`)}
      />
    );
  }
  if (tab === 'mine') {
    return <EmptyState title={t(`${key}.emptyMine`)} />;
  }
  return (
    <EmptyState
      action={canWrite ? <EmptyActionButton label={t(`${key}.newTask`)} onClick={onCreate} /> : undefined}
      description={t(`${key}.emptyDescription`)}
      title={t(`${key}.empty`)}
    />
  );
};

const useTasksPage = () => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [records, setRecords] = useState<RecordsResponse>();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [employees, setEmployees] = useState<readonly Employee[]>([]);
  const [employeesFailed, setEmployeesFailed] = useState(false);
  const [customers, setCustomers] = useState<readonly CustomerOption[]>([]);
  const [opportunities, setOpportunities] = useState<readonly OpportunityOption[]>([]);
  const [referenceFailed, setReferenceFailed] = useState(false);
  const [tab, setTab] = useState<TaskTab>('mine');
  const [filters, setFilters] = useState<TaskFilters>(initialTaskFilters);
  const [selection, setSelection] = useState<Record<string, true>>({});
  const [editor, setEditor] = useState<Editor>();
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    loadRecords({ setLoadState, setRecords });
    loadEmployees({ setEmployees, setEmployeesFailed });
    loadCustomerNames({ setCustomers, setOpportunities, setReferenceFailed });
    loadOpportunityNames({ setCustomers, setOpportunities, setReferenceFailed });
  }, []);

  const today = todayIsoDate();
  const employeeNames = new Map<string, string>(employees.map((employee) => [employee.id, employee.fullName]));
  const customerNames = new Map<string, string>(
    customers.flatMap((customer) =>
      customer.displayName === null ? [] : [[customer.partyId, customer.displayName] as const],
    ),
  );
  const opportunityTitles = new Map<string, string>(
    opportunities.map((opportunity) => [opportunity.id, opportunity.title] as const),
  );
  const canWrite = records?.canWrite === true;
  const mineEmployeeId =
    records === undefined ? undefined : employeeIdOf(records.actorPrincipalRef.principalId, employees);
  const visibleTasks = records === undefined ? [] : filterTasks(records.items, { filters, mineEmployeeId, tab });
  // Without an employee bound to this login, "mine" cannot narrow the list, so the page says so.
  const mineUnlinked = tab === 'mine' && records !== undefined && mineEmployeeId === undefined && employees.length > 0;
  const selectedIds = visibleTasks.flatMap((task) =>
    selection[task.ref.resourceId] === true ? [task.ref.resourceId] : [],
  );
  const filtersActive =
    filters.search !== '' || filters.assignee !== ALL || filters.priority !== ALL || filters.state !== ALL;

  // Runs one command against the revision the user saw, then reloads the list. Failures become messages.
  const runCommand = (command: WorkCommand, revision: number, onDone: (outcome: CommandOutcome) => void) =>
    browserRuntime.runFork(
      Effect.all({ id: requestId, referenceCredentials: makeReferenceGatewayCredentials([]) }, { concurrency: 1 }).pipe(
        Effect.flatMap(({ id, referenceCredentials }) =>
          executeApplyCommand({ command, expectedRevision: revision }, id, {
            idempotencyKey: id,
            referenceCredentials,
          }),
        ),
        Effect.flatMap((outcome) =>
          requestId.pipe(
            Effect.flatMap((id) => executeRecords({}, id)),
            Effect.map((fresh) => ({ fresh, outcome })),
          ),
        ),
        Effect.match({
          onFailure: (error): CommandOutcome => ({
            message: Match.value(error).pipe(
              Match.tag('ApplyCommandActionConflictProblem', () => t(`${key}.conflict`)),
              Match.tag('ApplyCommandActionForbiddenProblem', 'RecordsForbiddenProblem', () => t(`${key}.forbidden`)),
              Match.orElse(() => t(`${key}.invalid`)),
            ),
            ok: false,
          }),
          onSuccess: ({ fresh, outcome }): CommandOutcome => {
            setRecords(fresh);
            return { ok: true, results: outcome.results ?? [] };
          },
        }),
        Effect.map(onDone),
      ),
    );

  const save = (submission: TaskFormSubmission) => {
    if (records === undefined || editor === undefined) {
      return;
    }
    const fields: EditFields = {
      description: submission.description,
      priority: submission.priority,
      title: submission.title,
    };
    if (submission.assigneeEmployeeId !== undefined) {
      fields.assigneeEmployeeId = submission.assigneeEmployeeId;
    }
    if (submission.dueDate !== undefined) {
      fields.dueDate = submission.dueDate;
    }
    if (submission.opportunityId !== undefined) {
      fields.opportunityId = submission.opportunityId;
    }
    if (submission.partyId !== undefined) {
      fields.partyId = submission.partyId;
    }
    const command: WorkCommand =
      editor.mode === 'create'
        ? { _tag: 'CreateTask', ...fields }
        : { _tag: 'UpdateTask', ...fields, taskRef: editor.task.ref };
    const successKey = editor.mode === 'create' ? `${key}.created` : `${key}.saved`;
    setSaving(true);
    setFormError(undefined);
    runCommand(command, records.revision, (result) => {
      setSaving(false);
      if (result.ok) {
        setEditor(undefined);
        setActionError(undefined);
        toaster.create({ title: t(successKey), type: 'success' });
      } else {
        setFormError(result.message);
      }
    });
  };

  const finishBulk = (outcome: CommandOutcome, summaryKey: 'assigned' | 'changed') => {
    setBulkBusy(false);
    if (outcome.ok) {
      const changed = outcome.results.filter((item) => item.outcome === 'changed').length;
      setSelection({});
      toaster.create({
        title: t(`${key}.bulk.${summaryKey}`, { changed, skipped: outcome.results.length - changed }),
        type: 'success',
      });
    } else {
      setActionError(outcome.message);
    }
  };

  const handleBulkChangeState = (toState: Task['state']) => {
    if (records === undefined || selectedIds.length === 0) {
      return;
    }
    setBulkBusy(true);
    setActionError(undefined);
    runCommand({ _tag: 'BulkChangeTaskState', ids: selectedIds, toState }, records.revision, (outcome) =>
      finishBulk(outcome, 'changed'),
    );
  };

  const handleBulkAssign = (value: string) => {
    if (records === undefined || selectedIds.length === 0) {
      return;
    }
    // Wire `null` (Option none) clears the assignee; any other value must decode as an employee id.
    const assigneeEmployeeId = value === NONE ? Option.none() : decodeEmployeeId(value);
    if (value !== NONE && Option.isNone(assigneeEmployeeId)) {
      setActionError(t(`${key}.invalid`));
      return;
    }
    setBulkBusy(true);
    setActionError(undefined);
    runCommand({ _tag: 'BulkAssignTasks', assigneeEmployeeId, ids: selectedIds }, records.revision, (outcome) =>
      finishBulk(outcome, 'assigned'),
    );
  };

  const handleChangeTab = (value: string) => {
    if (Schema.is(TaskTabSchema)(value)) {
      setTab(value);
      setSelection({});
    }
  };

  const handleReload = () => {
    setLoadState('loading');
    loadRecords({ setLoadState, setRecords });
  };

  const handleOpenCreate = () => {
    setFormError(undefined);
    setEditor({ mode: 'create' });
  };

  const handleOpenEdit = (task: Task) => {
    setFormError(undefined);
    setEditor({ mode: 'edit', task });
  };

  const handleCloseEditor = () => {
    setEditor(undefined);
    setFormError(undefined);
  };

  return {
    actionError,
    bulkBusy,
    canWrite,
    customerNames,
    customers,
    editor,
    employeeNames,
    employees,
    employeesFailed,
    filters,
    filtersActive,
    formError,
    handleBulkAssign,
    handleBulkChangeState,
    handleChangeTab,
    handleClearFilters: () => setFilters(initialTaskFilters),
    handleCloseEditor,
    handleFiltersChange: setFilters,
    handleOpenCreate,
    handleOpenEdit,
    handleReload,
    handleSave: save,
    handleSelectionChange: setSelection,
    loadState,
    mineUnlinked,
    opportunities,
    opportunityTitles,
    records,
    referenceFailed,
    saving,
    selectedIds,
    selection,
    t,
    tab,
    today,
    visibleTasks,
  };
};

const TasksPageContent = () => {
  const model = useTasksPage();
  const { t } = model;
  const { records } = model;
  const columns = buildTaskColumns({
    customerNames: model.customerNames,
    employeeNames: model.employeeNames,
    opportunityTitles: model.opportunityTitles,
    t,
    today: model.today,
  });
  const selectedCount = model.selectedIds.length;

  return (
    <>
      <UltramodernRouteHead />
      <PageHeader
        actions={
          model.canWrite ? (
            <Button onClick={model.handleOpenCreate} size="sm" variant="primary">
              {t(`${key}.newTask`)}
            </Button>
          ) : undefined
        }
        description={t(`${key}.pageDescription`)}
        title={t(`${key}.title`)}
      />

      <StatRow>
        <StatCard label={t(`${key}.stats.open`)} value={formatCount(records?.indicators.open)} />
        <StatCard
          label={t(`${key}.stats.overdue`)}
          value={formatCount(records === undefined ? undefined : overdueCount(records.items, model.today))}
        />
        <StatCard
          label={t(`${key}.stats.doneThisWeek`)}
          value={formatCount(records === undefined ? undefined : doneThisWeek(records.items, model.today))}
        />
        <StatCard
          label={t(`${key}.stats.unassigned`)}
          value={formatCount(records === undefined ? undefined : unassignedOpenCount(records.items))}
        />
      </StatRow>

      <Tabs onValueChange={model.handleChangeTab} value={model.tab} variant="line">
        <Tabs.List>
          <Tabs.Trigger value="mine">{t(`${key}.tabs.mine`)}</Tabs.Trigger>
          <Tabs.Trigger value="all">{t(`${key}.tabs.all`)}</Tabs.Trigger>
          <Tabs.Indicator />
        </Tabs.List>
      </Tabs>

      {model.mineUnlinked && <p className="text-fg-secondary text-sm">{t(`${key}.mineUnlinked`)}</p>}

      <TaskFilterBar employees={model.employees} filters={model.filters} onChange={model.handleFiltersChange} />

      {model.canWrite && (
        <TaskBulkBar
          busy={model.bulkBusy}
          count={selectedCount}
          employees={model.employees}
          onAssign={model.handleBulkAssign}
          onChangeState={model.handleBulkChangeState}
          onClear={() => model.handleSelectionChange({})}
        />
      )}

      {model.loadState === 'error' && records !== undefined && (
        <StatusText showIcon status="error">
          {t(`${key}.unavailable`)}
        </StatusText>
      )}
      {model.employeesFailed && (
        <StatusText showIcon status="error">
          {t(`${key}.employeesUnavailable`)}
        </StatusText>
      )}
      {model.referenceFailed && (
        <StatusText showIcon status="error">
          {t(`${key}.referencesUnavailable`)}
        </StatusText>
      )}
      {model.actionError !== undefined && (
        <StatusText showIcon status="error">
          {model.actionError}
        </StatusText>
      )}

      <DataTable
        // The row-selection column must stay first, so it is pinned ahead of the title.
        columnPinning={{ end: [], start: ['__select', 'title'] }}
        columns={columns}
        data={model.visibleTasks}
        enableColumnPinning
        enablePagination
        enableRowSelection
        enableSorting
        getRowId={(row) => row.ref.resourceId}
        getRowLabel={(row) => row.original.title}
        loading={model.loadState === 'loading' && records === undefined}
        loadingRowCount={8}
        maxHeight="calc(100dvh - 15rem)"
        onRowClick={(row) => {
          if (model.canWrite) {
            model.handleOpenEdit(row.original);
          }
        }}
        onRowSelectionChange={model.handleSelectionChange}
        pageSizeOptions={[50, 100, 200]}
        renderEmpty={() => (
          <TaskEmptyState
            canWrite={model.canWrite}
            filtersActive={model.filtersActive}
            hasRecords={records !== undefined}
            loadState={model.loadState}
            onClear={model.handleClearFilters}
            onCreate={model.handleOpenCreate}
            onRetry={model.handleReload}
            tab={model.tab}
          />
        )}
        rowActions={
          model.canWrite
            ? [
                {
                  icon: 'icon-[mdi--pencil-outline]',
                  id: 'edit',
                  label: t(`${key}.edit`),
                  onAction: (row) => model.handleOpenEdit(row.original),
                },
              ]
            : []
        }
        rowSelection={model.selection}
        size="sm"
        stickyHeader
        tableLayout="fixed"
        translations={{
          actionsLabel: t(`${key}.table.actions`),
          loadingLabel: t(`${key}.table.loading`),
          pageSizeLabel: t(`${key}.table.pageSize`),
          rangeLabel: ({ end, start, total }: { end: number; start: number; total: number }) =>
            t(`${key}.table.range`, { end, start, total }),
          selectAllLabel: t(`${key}.table.selectAll`),
          selectionLabel: t(`${key}.table.selection`),
        }}
      />

      {model.editor !== undefined && (
        <TaskFormDialog
          busy={model.saving}
          customers={model.customers}
          employees={model.employees}
          error={model.formError}
          onClose={model.handleCloseEditor}
          onSubmit={model.handleSave}
          opportunities={model.opportunities}
          task={model.editor.mode === 'edit' ? model.editor.task : undefined}
        />
      )}
    </>
  );
};

// One Toaster for the whole page tree: the shell mounts none, and ui-kit's toast store is per remote.
export const RecordsPage = () => (
  <FederatedI18nBoundary
    defaultNamespace="siampark-work"
    fallbackLanguage="en"
    resources={siamparkWorkI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <Toaster />
    <TasksPageContent />
  </FederatedI18nBoundary>
);

export default RecordsPage;
