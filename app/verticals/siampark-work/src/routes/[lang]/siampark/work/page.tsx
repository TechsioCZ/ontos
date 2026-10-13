import { EmptyState, PageHeader, StatCard, StatRow, Toaster, dataTableRowLabels } from '@app/admin-ui';
import { listCustomers } from '@app/party-registry/api/client';
import { listOpportunities } from '@app/sales-pipeline/clients/records';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { listEmployees } from '@app/workforce/clients/records';
import type { Employee } from '@app/workforce/contracts/records';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import { Effect, Match, Option, Random, Schema } from 'effect';
import type { Types } from 'effect';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useEffect, useRef, useState } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { executeRecords } from '../../../../api/records-client.ts';
import { executeApplyCommand } from '../../../../api/apply-command-action-client.ts';
import type { BulkSkipReason, WorkCommand } from '../../../../../shared/actions/apply-command.ts';
import { canTransition, isClosedTaskState } from '../../../../../shared/actions/task-transitions.ts';
import { EmployeeIdSchema } from '../../../../../shared/apis/records.ts';
import type { RecordsResponse, Task, TaskState } from '../../../../../shared/apis/records.ts';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { buildTaskColumns } from './tasks-columns.tsx';
import type { LookupState } from './tasks-columns.tsx';
import { TaskBulkBar, TaskFilterBar } from './tasks-filters.tsx';
import { TaskFormDialog } from './task-form-dialog.tsx';
import type { TaskFormSubmission } from './task-form-dialog.tsx';
import {
  TaskTabSchema,
  commonTransitionTargets,
  doneThisWeek,
  employeeIdOf,
  filterTasks,
  initialTaskFilters,
  overdueCount,
  readStoredTaskView,
  todayIsoDate,
  unassignedOpenCount,
  writeStoredTaskView,
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
const BULK_TOAST_DURATION_MS = 6000;
// zag's 2 s default for success toasts ends before the eye returns from the closing panel.
const SUCCESS_TOAST_DURATION_MS = 5000;
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
  | {
      readonly ok: true;
      readonly results: readonly {
        readonly outcome: 'changed' | 'skipped';
        readonly reason?: BulkSkipReason;
      }[];
    }
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
  readonly settle: (name: keyof LookupState) => void;
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

const loadEmployees = ({ setEmployees, setEmployeesFailed, settle }: EmployeeSetters) => {
  browserRuntime.runFork(
    listEmployees().pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.logWarning('Employee list unavailable.', error).pipe(
            Effect.andThen(
              Effect.sync(() => {
                setEmployeesFailed(true);
                settle('employees');
              }),
            ),
          ),
        onSuccess: (items) =>
          Effect.sync(() => {
            setEmployees(items);
            setEmployeesFailed(false);
            settle('employees');
          }),
      }),
    ),
  );
};

interface ReferenceSetters {
  readonly setCustomers: (customers: readonly CustomerOption[]) => void;
  readonly setOpportunities: (opportunities: readonly OpportunityOption[]) => void;
  readonly setReferenceFailed: (failed: boolean) => void;
  readonly settle: (name: keyof LookupState) => void;
}

// Names for the table and the pickers. A failed load leaves the ids visible as muted placeholders.
const loadCustomerNames = ({ setCustomers, setReferenceFailed, settle }: ReferenceSetters) => {
  browserRuntime.runFork(
    listCustomers().pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.logWarning('Customer list unavailable.', error).pipe(
            Effect.andThen(
              Effect.sync(() => {
                setReferenceFailed(true);
                settle('customers');
              }),
            ),
          ),
        onSuccess: (items) =>
          Effect.sync(() => {
            setCustomers(items);
            settle('customers');
          }),
      }),
    ),
  );
};

const loadOpportunityNames = ({ setOpportunities, setReferenceFailed, settle }: ReferenceSetters) => {
  browserRuntime.runFork(
    requestId.pipe(
      Effect.flatMap((id) => listOpportunities({}, id)),
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.logWarning('Opportunity list unavailable.', error).pipe(
            Effect.andThen(
              Effect.sync(() => {
                setReferenceFailed(true);
                settle('opportunities');
              }),
            ),
          ),
        onSuccess: (result) =>
          Effect.sync(() => {
            setOpportunities(result.items);
            settle('opportunities');
          }),
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
  const [lookups, setLookups] = useState<LookupState>({ customers: false, employees: false, opportunities: false });
  const [tab, setTab] = useState<TaskTab>('mine');
  const [filters, setFilters] = useState<TaskFilters>(initialTaskFilters);
  // Default order: the nearest due date first. Tasks without a date sort last (column option).
  const [sorting, setSorting] = useState<{ desc: boolean; id: string }[]>([{ desc: false, id: 'dueDate' }]);
  const [selection, setSelection] = useState<Record<string, true>>({});
  const [editor, setEditor] = useState<Editor>();
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [bulkBusy, setBulkBusy] = useState(false);
  // The control that opened the task panel. The panel unmounts on close, so focus goes back there explicitly.
  const panelOpener = useRef<HTMLElement | null>(null);

  const openEditor = (next: Editor) => {
    // `:focus` never matches <body>, so a click that focused nothing records no opener.
    panelOpener.current = globalThis.document.querySelector<HTMLElement>(':focus');
    setFormError(undefined);
    setEditor(next);
  };

  const closeEditor = () => {
    setEditor(undefined);
    const opener = panelOpener.current;
    panelOpener.current = null;
    // Runs after the panel unmounts and only moves a focus that fell to <body>, so a restore zag made stays put.
    globalThis.requestAnimationFrame(() => {
      if (opener?.isConnected === true && globalThis.document.activeElement === globalThis.document.body) {
        opener.focus({ preventScroll: true });
      }
    });
  };

  useEffect(() => {
    // Read after mount: the first render matches the server, and the saved view applies on top of it.
    const stored = readStoredTaskView();
    if (stored !== undefined) {
      // oxlint-disable-next-line react/set-state-in-effect -- One-time sync from sessionStorage after mount; initial state from storage would break server/client hydration.
      setTab(stored.tab);
      setFilters(stored.filters);
    }
    const settle = (name: keyof LookupState) => setLookups((current) => ({ ...current, [name]: true }));
    loadRecords({ setLoadState, setRecords });
    loadEmployees({ setEmployees, setEmployeesFailed, settle });
    loadCustomerNames({ setCustomers, setOpportunities, setReferenceFailed, settle });
    loadOpportunityNames({ setCustomers, setOpportunities, setReferenceFailed, settle });
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
  // "Mine" narrows by the employee linked to this login; until the employees settle the table stays in its loading
  // state instead of flashing every task.
  const mineResolving = tab === 'mine' && !lookups.employees;
  const visibleTasks =
    records === undefined || mineResolving
      ? []
      : filterTasks(records.items, { customerNames, employeeNames, filters, mineEmployeeId, tab, today });
  // The header shows the role only, so the "mine" tab names the employee it narrows to.
  const mineName = mineEmployeeId === undefined ? undefined : employeeNames.get(mineEmployeeId);
  // Without an employee bound to this login, "mine" cannot narrow the list, so the page says so.
  const mineUnlinked = tab === 'mine' && records !== undefined && mineEmployeeId === undefined && employees.length > 0;
  // A row selected before it closed drops out here, so a bulk command never carries a closed task.
  const selectedTasks = visibleTasks.filter(
    (task) => selection[task.ref.resourceId] === true && !isClosedTaskState(task.state),
  );
  const selectedIds = selectedTasks.map((task) => task.ref.resourceId);
  const stateTargets = commonTransitionTargets(selectedTasks);
  const filtersActive =
    filters.search !== '' ||
    filters.assignee !== ALL ||
    filters.due !== ALL ||
    filters.priority !== ALL ||
    filters.state !== ALL;

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
              // A closed task never changes, so a retry cannot help; the lifecycle conflict gets its own message.
              Match.tag('ApplyCommandActionConflictProblem', (conflict) =>
                t(conflict.code === 'work_lifecycle_conflict' ? `${key}.closedTask` : `${key}.conflict`),
              ),
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
        closeEditor();
        setActionError(undefined);
        toaster.create({ duration: SUCCESS_TOAST_DURATION_MS, title: t(successKey), type: 'success' });
      } else {
        setFormError(result.message);
      }
    });
  };

  const finishBulk = (outcome: CommandOutcome, summaryKey: 'assigned' | 'changed') => {
    setBulkBusy(false);
    if (outcome.ok) {
      const changed = outcome.results.filter((item) => item.outcome === 'changed').length;
      // Each skipped id has a reason; the toast names every distinct one so the skipped count is explained.
      const skipReasons = [
        ...new Set(
          outcome.results.flatMap((item) =>
            item.outcome === 'skipped' && item.reason !== undefined ? [item.reason] : [],
          ),
        ),
      ];
      const skipped = outcome.results.length - changed;
      setSelection({});
      // The summary carries counts to read, so it stays longer than zag's short default for success toasts.
      // Skipped rows turn it into a warning, so the explanation is not read as a plain success.
      const title = t(`${key}.bulk.${summaryKey}`, { changed, skipped });
      if (skipped === 0) {
        toaster.create({ duration: BULK_TOAST_DURATION_MS, title, type: 'success' });
      } else {
        toaster.create({
          description: skipReasons.map((reason) => t(`${key}.bulk.skipped.${reason}`)).join(' '),
          duration: BULK_TOAST_DURATION_MS,
          title,
          type: 'warning',
        });
      }
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

  // Row start and complete. Only transitions the table allows are offered, so the server accepts them.
  const handleChangeRowState = (task: Task, toState: TaskState) => {
    if (records === undefined) {
      return;
    }
    setActionError(undefined);
    runCommand({ _tag: 'ChangeTaskState', state: toState, taskRef: task.ref }, records.revision, (outcome) => {
      if (outcome.ok) {
        toaster.create({
          duration: SUCCESS_TOAST_DURATION_MS,
          title: t(toState === 'DONE' ? `${key}.completed` : `${key}.started`),
          type: 'success',
        });
      } else {
        setActionError(outcome.message);
      }
    });
  };

  const handleChangeTab = (value: string) => {
    if (Schema.is(TaskTabSchema)(value)) {
      setTab(value);
      setSelection({});
      writeStoredTaskView({ filters, tab: value });
    }
  };

  const handleFiltersChange = (next: TaskFilters) => {
    setFilters(next);
    writeStoredTaskView({ filters: next, tab });
  };

  const handleReload = () => {
    setLoadState('loading');
    loadRecords({ setLoadState, setRecords });
  };

  const handleOpenCreate = () => {
    openEditor({ mode: 'create' });
  };

  const handleOpenEdit = (task: Task) => {
    openEditor({ mode: 'edit', task });
  };

  const handleCloseEditor = () => {
    closeEditor();
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
    handleChangeRowState,
    handleChangeTab,
    handleClearFilters: () => handleFiltersChange(initialTaskFilters),
    handleCloseEditor,
    handleFiltersChange,
    handleOpenCreate,
    handleOpenEdit,
    handleReload,
    handleSave: save,
    handleSelectionChange: setSelection,
    handleSortingChange: setSorting,
    loadState,
    lookups,
    mineName,
    mineResolving,
    mineUnlinked,
    opportunities,
    opportunityTitles,
    records,
    referenceFailed,
    saving,
    selectedIds,
    selection,
    sorting,
    stateTargets,
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
    lookups: model.lookups,
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
          <Tabs.Trigger value="mine">
            {model.mineName === undefined
              ? t(`${key}.tabs.mine`)
              : t(`${key}.tabs.mineNamed`, { name: model.mineName })}
          </Tabs.Trigger>
          <Tabs.Trigger value="all">{t(`${key}.tabs.all`)}</Tabs.Trigger>
          <Tabs.Indicator />
        </Tabs.List>
      </Tabs>

      {model.mineUnlinked && <p className="text-fg-secondary text-sm">{t(`${key}.mineUnlinked`)}</p>}

      <TaskFilterBar
        active={model.filtersActive}
        employees={model.employees}
        filters={model.filters}
        onChange={model.handleFiltersChange}
        onClear={model.handleClearFilters}
      />

      {model.canWrite && (
        <TaskBulkBar
          busy={model.bulkBusy}
          count={selectedCount}
          employees={model.employees}
          onAssign={model.handleBulkAssign}
          onChangeState={model.handleBulkChangeState}
          onClear={() => model.handleSelectionChange({})}
          targets={model.stateTargets}
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
        // Completed and cancelled tasks cannot be reassigned or moved, so they are not offered for selection.
        canSelectRow={(row) => !isClosedTaskState(row.original.state)}
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
        loading={(model.loadState === 'loading' && records === undefined) || model.mineResolving}
        loadingRowCount={8}
        maxHeight="calc(100dvh - 15rem)"
        onRowClick={(row) => {
          if (model.canWrite) {
            model.handleOpenEdit(row.original);
          }
        }}
        onRowSelectionChange={model.handleSelectionChange}
        onSortingChange={model.handleSortingChange}
        pageSizeOptions={[50, 100, 200]}
        paginationProps={{
          translations: {
            firstTriggerLabel: t(`${key}.pagination.first`),
            itemLabel: ({ page }: { page: number }) => t(`${key}.pagination.page`, { page }),
            lastTriggerLabel: t(`${key}.pagination.last`),
            nextTriggerLabel: t(`${key}.pagination.next`),
            prevTriggerLabel: t(`${key}.pagination.previous`),
            rootLabel: t(`${key}.pagination.label`),
          },
        }}
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
                  hidden: (row) => !canTransition(row.original.state, 'IN_PROGRESS'),
                  icon: 'icon-[mdi--play-outline]',
                  id: 'start',
                  label: t(`${key}.start`),
                  onAction: (row) => model.handleChangeRowState(row.original, 'IN_PROGRESS'),
                },
                {
                  hidden: (row) => !canTransition(row.original.state, 'DONE'),
                  icon: 'icon-[mdi--check-circle-outline]',
                  id: 'complete',
                  label: t(`${key}.complete`),
                  onAction: (row) => model.handleChangeRowState(row.original, 'DONE'),
                },
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
        sorting={model.sorting}
        stickyHeader
        tableLayout="fixed"
        translations={{
          ...dataTableRowLabels,
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
