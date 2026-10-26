import { EmptyState, PageHeader, StatCard, StatRow, Toaster, dataTableRowLabels } from '@app/admin-ui';
import { listCustomers } from '@app/party-registry/api/client';
import { listOpportunities } from '@app/sales-pipeline/clients/records';
import { executeRecords as propertyRecords } from '@app/property-portfolio/clients/records';
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { definePageData, modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageProps, PageData, PageDataSnapshot } from '@app/shared-contracts/page-data';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import { Effect, Match, Option, Predicate, Random, Schedule, Schema, Struct } from 'effect';
import type { Types } from 'effect';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import { executeRecords } from '../../../api/records-client.ts';
import { executeApplyCommand } from '../../../api/apply-command-action-client.ts';
import { BulkWorkCommandSchema } from '../../../../shared/actions/apply-command.ts';
import type {
  ApplyCommandResultSchema,
  BulkSkipReason,
  WorkCommand,
} from '../../../../shared/actions/apply-command.ts';
import { canTransition, isClosedTaskState } from '../../../../shared/actions/task-transitions.ts';
import { PartyIdSchema } from '../../../../shared/apis/records.ts';
import type { LookupAccess, RecordsResponse, Task, TaskState } from '../../../../shared/apis/records.ts';
import { UltramodernRouteHead } from '../../ultramodern-route-head';
import { buildTaskColumns } from './tasks-columns.tsx';
import type { LookupState } from './tasks-columns.tsx';
import { TaskBulkBar, TaskFilterBar } from './tasks-filters.tsx';
import { TaskFormDialog } from './task-form-dialog.tsx';
import { WorkPlanning } from './work-planning.tsx';
import { principalKey } from '../../../../shared/assignment.ts';
import { assignmentPatch, selectedPrincipal } from './assignment-options.ts';
import type { TaskFormSubmission } from './task-form-dialog.tsx';
import {
  TaskTabSchema,
  commonTransitionTargets,
  doneThisWeek,
  defaultTaskTab,
  filterTasks,
  initialTaskFilters,
  overdueCount,
  storedTaskViewServerSnapshot,
  storedTaskViewSnapshot,
  subscribeStoredTaskView,
  taskViewFromSnapshot,
  todayIsoDate,
  unassignedOpenCount,
  withBulkResult,
  withSavedTask,
  writeStoredTaskView,
} from './tasks-model.ts';
import type { CustomerOption, ObjectOption, OpportunityOption, TaskFilters, TaskTab } from './tasks-model.ts';
import csResource from '../../../../locales/cs/work-tasks.json';
import enResource from '../../../../locales/en/work-tasks.json';
import '../../index.css';

const workTasksI18nResources = {
  cs: { 'work-tasks': csResource },
  en: { 'work-tasks': enResource },
} as const;

const key = 'work-tasks.pages.records';
const NONE = 'none';
const ALL = 'all';
const BULK_TOAST_DURATION_MS = 6000;
// zag's 2 s default for success toasts ends before the eye returns from the closing panel.
const SUCCESS_TOAST_DURATION_MS = 5000;
const count = new Intl.NumberFormat('cs-CZ');

type EditFields = Types.Mutable<
  Pick<
    Extract<WorkCommand, { readonly _tag: 'CreateTask' }>,
    | 'ownerPrincipalRef'
    | 'contextRefs'
    | 'description'
    | 'dueDate'
    | 'opportunityId'
    | 'partyId'
    | 'priority'
    | 'title'
    | 'plannedHours'
    | 'projectId'
  >
>;
const LoadStateSchema = Schema.Literals(['loading', 'ready', 'error', 'forbidden']);
type LoadState = typeof LoadStateSchema.Type;
type Editor = { readonly mode: 'create' } | { readonly mode: 'edit'; readonly task: Task };
type ApplyCommandOutcome = typeof ApplyCommandResultSchema.Type;
type CommandOutcome =
  | {
      readonly ok: true;
      readonly results: readonly {
        readonly outcome: 'changed' | 'skipped';
        readonly reason?: BulkSkipReason;
      }[];
    }
  | { readonly message: string; readonly ok: false };

type PageReadFailure = Effect.Error<
  ReturnType<typeof executeRecords> | ReturnType<typeof listCustomers> | ReturnType<typeof listOpportunities>
>;
const isForbiddenReadFailure = (error: PageReadFailure): boolean =>
  Match.value(error).pipe(
    Match.tag('CustomerListForbiddenProblem', 'GatewayForbiddenProblem', 'RecordsForbiddenProblem', () => true),
    Match.orElse(() => false),
  );

/**
 * A read that fails while the gateway is busy (several lists load at once on the first visit) is tried twice more
 * before the page reports it. A forbidden answer is final.
 */
const retryTransient = <A, E extends PageReadFailure, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      schedule: Schedule.spaced('800 millis'),
      times: 2,
      while: (error: E) => !isForbiddenReadFailure(error),
    }),
  );

const requestId = Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
  Effect.map(([first, second]) => `work-tasks:${first}:${second}`),
);

// On a phone the pinned Název and the sticky Akce column are wider than the table, so no other column could scroll
// into view between them. Below this width both scroll with the rest of the row.
const narrowViewportQuery = '(max-width: 39.99rem)';
const subscribeNarrowViewport = (onChange: () => void) => {
  const query = globalThis.matchMedia(narrowViewportQuery);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};
const useNarrowViewport = () =>
  useSyncExternalStore(
    subscribeNarrowViewport,
    () => globalThis.matchMedia(narrowViewportQuery).matches,
    // The server render keeps the desktop pinning; the first client render corrects it.
    () => false,
  );

const formatCount = (value: number | undefined) => (value === undefined ? '—' : count.format(value));

const recordsRequest = (partyId: typeof PartyIdSchema.Type | undefined, includeArchived: boolean) => ({
  ...(partyId === undefined ? {} : { partyId }),
  ...(includeArchived ? { includeArchived } : {}),
});

/** The task list a page shows: the person's legal entity, the optional `partyId` filter and the archive toggle. */
interface TasksInput {
  readonly includeArchived: boolean;
  readonly legalEntityId: string;
  readonly partyId: typeof PartyIdSchema.Type | undefined;
}

/** The page's primary data: loaded before the Shell reveals the page, kept per document, revalidated after writes. */
const taskRecords = definePageData({
  key: ({ includeArchived, legalEntityId, partyId }: TasksInput) =>
    `${legalEntityId}|${partyId ?? ''}|${includeArchived ? 'archived' : 'current'}`,
  load: ({ includeArchived, partyId }: TasksInput) =>
    requestId.pipe(
      Effect.flatMap((id) => executeRecords(recordsRequest(partyId, includeArchived), id)),
      retryTransient,
    ),
  runtime: browserRuntime,
});

// Optional business-reference names load only when the work-tasks read allows their owner.
const customerDirectory = definePageData({
  key: (legalEntityId: string) => legalEntityId,
  load: () =>
    listCustomers().pipe(
      retryTransient,
      Effect.tapError((failure) => Effect.logWarning('Customer list unavailable.', failure)),
    ),
  runtime: browserRuntime,
});

const opportunityDirectory = definePageData({
  key: (legalEntityId: string) => legalEntityId,
  load: () =>
    requestId.pipe(
      Effect.flatMap((id) => listOpportunities({}, id)),
      Effect.map((result) => result.items),
      retryTransient,
      Effect.tapError((failure) => Effect.logWarning('Opportunity list unavailable.', failure)),
    ),
  runtime: browserRuntime,
});

/** A denied directory is not a task failure, so it is not reported as unavailable. */
const lookupFailed = <E extends PageReadFailure>(snapshot: PageDataSnapshot<unknown, E>) =>
  snapshot.state === 'failed' && !isForbiddenReadFailure(snapshot.error);

const preloadDirectories = (legalEntityId: string, access: LookupAccess | undefined) =>
  Effect.all(
    [
      access?.customers === 'allowed' ? customerDirectory.preload(legalEntityId) : Effect.void,
      access?.opportunities === 'allowed' ? opportunityDirectory.preload(legalEntityId) : Effect.void,
    ],
    { concurrency: 2, discard: true },
  );

/** The task list, then the name directories it allows, so the table shows names in its first commit. */
const preloadTasks = (input: TasksInput) =>
  taskRecords.preload(input).pipe(
    Effect.andThen(
      Effect.suspend(() => {
        const snapshot = taskRecords.snapshot(input);
        return snapshot.state === 'ready'
          ? preloadDirectories(input.legalEntityId, snapshot.value.lookupAccess)
          : Effect.void;
      }),
    ),
  );

/** Decodes a raw query string (`?partyId=…`, the shape the Shell passes as `search`); none when the filter is invalid. */
const partySearchCodec = Schema.toCodecJson(
  Schema.fromURLSearchParams(Schema.Struct({ partyId: Schema.optional(PartyIdSchema) })),
);
const requestedParty = (search: string) =>
  Schema.decodeOption(partySearchCodec)(search).pipe(Option.map((decoded) => decoded.partyId));

export const preloadPage = modulePagePreload((props) =>
  Option.match(requestedParty(props.search), {
    onNone: () => Effect.void,
    onSome: (partyId) =>
      preloadTasks({ includeArchived: false, legalEntityId: props.context?.legalEntityId ?? '', partyId }),
  }),
);

/** One name directory of the page: read synchronously, loaded on a cold mount once the task list allows it. */
const useDirectory = <A, E>(directory: PageData<string, A, E>, legalEntityId: string, allowed: boolean) => {
  const snapshot = useSyncExternalStore(
    directory.subscribe,
    () => directory.snapshot(legalEntityId),
    () => pageDataPending,
  );
  useEffect(() => {
    if (allowed) {
      directory.ensure(legalEntityId);
    }
  }, [allowed, directory, legalEntityId]);
  return snapshot;
};

const noCustomers: readonly CustomerOption[] = [];
const noOpportunities: readonly OpportunityOption[] = [];

/** Properties and units for the Objekt filter and the history names. Units sort under their property. */
const loadObjects = (setObjects: (objects: readonly ObjectOption[] | undefined) => void) => {
  browserRuntime.runFork(
    requestId.pipe(
      Effect.flatMap((id) => propertyRecords({}, id)),
      Effect.retry({ schedule: Schedule.spaced('800 millis'), times: 3 }),
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.logWarning('Property list unavailable.', error).pipe(
            Effect.andThen(Effect.sync(() => setObjects(undefined))),
          ),
        onSuccess: (records) =>
          Effect.sync(() =>
            setObjects(
              records.properties.flatMap((property) => [
                { id: property.propertyRef.resourceId, label: `${property.code} · ${property.name}` },
                ...records.units
                  .filter((unit) => unit.propertyRef.resourceId === property.propertyRef.resourceId)
                  .map((unit) => ({
                    id: unit.unitRef.resourceId,
                    label: `${property.code} / ${unit.code} · ${unit.name}`,
                    propertyId: property.propertyRef.resourceId,
                  })),
              ]),
            ),
          ),
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

// Completed and cancelled rows show a disabled checkbox; this line says why, once any of them is listed.
const ClosedRowsHint = ({ visible }: { readonly visible: boolean }) => {
  const { t } = useModernI18n();
  return visible ? <p className="text-fg-secondary text-sm">{t(`${key}.bulk.closedHint`)}</p> : null;
};

const useTaskView = (partyId: typeof PartyIdSchema.Type | undefined, invalidFilter: boolean) => {
  const snapshot = useSyncExternalStore(subscribeStoredTaskView, storedTaskViewSnapshot, storedTaskViewServerSnapshot);
  const stored = partyId === undefined && !invalidFilter ? taskViewFromSnapshot(snapshot) : undefined;
  const [tabOverride, setTabOverride] = useState<TaskTab>();
  const [filtersOverride, setFiltersOverride] = useState<TaskFilters>();
  const tab = tabOverride ?? stored?.tab ?? (partyId === undefined ? undefined : 'all');
  const filters = filtersOverride ?? stored?.filters ?? initialTaskFilters;
  return { filters, setFilters: setFiltersOverride, setTab: setTabOverride, tab };
};

const loadStateOf = (snapshot: PageDataSnapshot<RecordsResponse, { readonly _tag: string }>): LoadState => {
  if (snapshot.state === 'ready') {
    return 'ready';
  }
  if (snapshot.state === 'pending' || snapshot.refreshing) {
    return 'loading';
  }
  return Predicate.isTagged('RecordsForbiddenProblem')(snapshot.error) ? 'forbidden' : 'error';
};

const useTasksPage = (
  legalEntityId: string,
  partyId: typeof PartyIdSchema.Type | undefined,
  invalidFilter: boolean,
) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [showHidden, setShowHidden] = useState(false);
  const input: TasksInput = { includeArchived: showHidden, legalEntityId, partyId };
  const recordsSnapshot = useSyncExternalStore(
    taskRecords.subscribe,
    () => taskRecords.snapshot(input),
    () => pageDataPending,
  );
  useEffect(() => {
    if (!invalidFilter) {
      taskRecords.ensure({ includeArchived: showHidden, legalEntityId, partyId });
    }
  }, [invalidFilter, legalEntityId, partyId, showHidden]);
  const records = recordsSnapshot.state === 'ready' ? recordsSnapshot.value : undefined;
  const loadState = loadStateOf(recordsSnapshot);
  const lookupAccess = records?.lookupAccess;
  const customersAllowed = lookupAccess?.customers === 'allowed';
  const opportunitiesAllowed = lookupAccess?.opportunities === 'allowed';
  const customersSnapshot = useDirectory(customerDirectory, legalEntityId, customersAllowed);
  const opportunitiesSnapshot = useDirectory(opportunityDirectory, legalEntityId, opportunitiesAllowed);
  const customers = customersAllowed && customersSnapshot.state === 'ready' ? customersSnapshot.value : noCustomers;
  const opportunities =
    opportunitiesAllowed && opportunitiesSnapshot.state === 'ready' ? opportunitiesSnapshot.value : noOpportunities;
  const referenceFailed =
    lookupAccess?.customers === 'unavailable' ||
    lookupAccess?.opportunities === 'unavailable' ||
    (customersAllowed && lookupFailed(customersSnapshot)) ||
    (opportunitiesAllowed && lookupFailed(opportunitiesSnapshot));
  // A directory the list does not allow is settled at once; an allowed one once it loaded or failed.
  const lookups: LookupState = {
    customers: !customersAllowed || customersSnapshot.state !== 'pending',
    principals: records !== undefined,
    opportunities: !opportunitiesAllowed || opportunitiesSnapshot.state !== 'pending',
  };
  const [loadedObjects, setLoadedObjects] = useState<readonly ObjectOption[]>();
  const { filters: storedFilters, setFilters, setTab, tab: preferredTab } = useTaskView(partyId, invalidFilter);
  // A saved filter from a broader role cannot silently hide rows when its directory is no longer available.
  const filters = storedFilters;
  // Default order: the nearest due date first. Tasks without a date sort last (column option).
  const [sorting, setSorting] = useState<{ desc: boolean; id: string }[]>([{ desc: false, id: 'dueDate' }]);
  const [selection, setSelection] = useState<Record<string, true>>({});
  const [editor, setEditor] = useState<Editor>();
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [bulkBusy, setBulkBusy] = useState(false);
  // A start or complete command has not answered yet. Commands are checked against one list revision, so a second
  // row action waits instead of failing as a conflict.
  const [rowBusy, setRowBusy] = useState(false);
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

  // The Objekt filter and the history names are secondary, so they load after the page shows.
  const propertiesAccess = lookupAccess?.properties;
  useEffect(() => {
    if (propertiesAccess === 'allowed') {
      loadObjects(setLoadedObjects);
    }
  }, [propertiesAccess]);
  const objects = propertiesAccess === 'allowed' ? loadedObjects : undefined;

  const linkedTaskOpened = useRef(false);
  useEffect(() => {
    const id = new URL(globalThis.location.href).searchParams.get('resourceId');
    if (id === null || records === undefined || linkedTaskOpened.current) {
      return;
    }
    linkedTaskOpened.current = true;
    const openLinked = (linked: Task) => {
      setTab('all');
      setFilters(initialTaskFilters);
      openEditor({ mode: 'edit', task: linked });
    };
    const listed = records.items.find((task) => task.ref.resourceId === id);
    if (listed !== undefined) {
      openLinked(listed);
      return;
    }
    // A task hidden from the list still opens from its direct link.
    browserRuntime.runFork(
      requestId.pipe(
        Effect.flatMap((correlation) => executeRecords({ resourceId: id }, correlation)),
        Effect.match({
          onFailure: () => setActionError(t(`${key}.forbidden`)),
          onSuccess: (result) => {
            const linked = result.items.find((task) => task.ref.resourceId === id);
            if (linked === undefined) {
              setActionError(t(`${key}.forbidden`));
            } else {
              openLinked(linked);
            }
          },
        }),
      ),
    );
  }, [records, t]);
  const today = todayIsoDate();
  const principals = records?.assignablePrincipals ?? [];
  const principalNames = new Map<string, string>(
    (records?.principalNames ?? []).map(({ displayName, principalRef }) => [principalKey(principalRef), displayName]),
  );
  const customerNames = new Map<string, string>(
    customers.flatMap((customer) =>
      customer.displayName === null ? [] : [[customer.partyId, customer.displayName] as const],
    ),
  );
  const opportunityTitles = new Map<string, string>(
    opportunities.map((opportunity) => [opportunity.id, opportunity.title] as const),
  );
  const canWrite = records?.canWrite === true;
  const unitProperty = new Map<string, string>(
    (objects ?? []).flatMap((item) => (item.propertyId === undefined ? [] : [[item.id, item.propertyId] as const])),
  );
  const contextLabels = new Map<string, string>((objects ?? []).map((item) => [item.id, item.label] as const));
  const actorName = (principalId: string, displayName?: string) =>
    displayName ?? (principalId === records?.actorPrincipalRef.principalId ? 'Vy' : 'Účet mimo seznam');
  const tab = preferredTab ?? defaultTaskTab(records?.items ?? [], records?.actorPrincipalRef);
  const visibleTasks =
    records === undefined
      ? []
      : filterTasks(records.items, {
          customerNames,
          filters,
          minePrincipalRef: records.actorPrincipalRef,
          principalNames,
          tab,
          today,
          unitProperty,
        });
  const mineName = records === undefined ? undefined : principalNames.get(principalKey(records.actorPrincipalRef));
  // A row selected before it closed drops out here, so a bulk command never carries a closed task.
  const selectedTasks = visibleTasks.filter(
    (task) => selection[task.ref.resourceId] === true && !isClosedTaskState(task.state),
  );
  const selectedIds = selectedTasks.map((task) => task.ref.resourceId);
  const stateTargets = commonTransitionTargets(selectedTasks);
  const closedRowsShown = canWrite && visibleTasks.some((task) => isClosedTaskState(task.state));
  const filtersActive =
    filters.search !== '' ||
    filters.assignee !== ALL ||
    filters.due !== ALL ||
    filters.priority !== ALL ||
    filters.state !== ALL ||
    filters.object !== ALL ||
    filters.dueFrom !== '' ||
    filters.dueTo !== '';

  const showSavedTask = (saved: Task, revision: number) => {
    taskRecords.update(input, (current) => withSavedTask(current, saved, revision));
    setEditor((current) =>
      current?.mode === 'edit' && current.task.ref.resourceId === saved.ref.resourceId
        ? { mode: 'edit', task: saved }
        : current,
    );
  };
  // The list re-reads behind a result that is already shown; a failed re-read keeps the rows on screen. The newest
  // re-read wins, so one answered before a later command never replaces the rows that command saved.
  const refreshInBackground = () => browserRuntime.runFork(taskRecords.refresh(input));

  // A single command returns the saved task, so its row updates in place. A bulk command returns which ids changed,
  // so those rows take the change it applied. Either way the next command is checked against the returned revision.
  const showCommandResult = (command: WorkCommand, outcome: ApplyCommandOutcome) => {
    const { results, revision, task } = outcome;
    if (task !== undefined) {
      showSavedTask(task, revision);
    } else if (Schema.is(BulkWorkCommandSchema)(command)) {
      taskRecords.update(input, (current) => withBulkResult(current, command, results ?? [], revision));
    } else {
      taskRecords.update(input, (current) => ({ ...current, revision }));
    }
    refreshInBackground();
  };

  // Runs one command against the revision the user saw. The result shows as soon as the command answers, and the
  // list reloads behind it, since each reload costs a gateway round trip. Failures become messages.
  const runCommand = (command: WorkCommand, revision: number, onDone: (outcome: CommandOutcome) => void) =>
    browserRuntime.runFork(
      Effect.all(
        {
          id: requestId,
          referenceCredentials: makeReferenceGatewayCredentials(
            Predicate.isTagged('CreateTask')(command) || Predicate.isTagged('UpdateTask')(command)
              ? (command.contextRefs ?? []).map((ref) =>
                  ref.moduleId === 'legal.agreements' ? 'legal-agreements' : 'property-portfolio',
                )
              : [],
          ),
        },
        { concurrency: 1 },
      ).pipe(
        Effect.flatMap(({ id, referenceCredentials }) =>
          executeApplyCommand({ command, expectedRevision: revision }, id, {
            idempotencyKey: id,
            referenceCredentials,
          }),
        ),
        Effect.tap((outcome) => Effect.sync(() => showCommandResult(command, outcome))),
        Effect.match({
          onFailure: (error): CommandOutcome => ({
            message: Match.value(error).pipe(
              // A closed task never changes, so a retry cannot help; the lifecycle conflict gets its own message.
              Match.tag('ApplyCommandActionConflictProblem', (conflict) =>
                t(conflict.code === 'work_lifecycle_conflict' ? `${key}.closedTask` : `${key}.conflict`),
              ),
              Match.tag('ApplyCommandActionForbiddenProblem', () => t(`${key}.forbidden`)),
              Match.orElse(() => t(`${key}.invalid`)),
            ),
            ok: false,
          }),
          onSuccess: (outcome): CommandOutcome => ({ ok: true, results: outcome.results ?? [] }),
        }),
        Effect.map(onDone),
      ),
    );

  const save = (submission: TaskFormSubmission) => {
    if (records === undefined || editor === undefined) {
      return;
    }
    const fields: EditFields = {
      ...(lookupAccess?.properties === 'allowed' || lookupAccess?.contracts === 'allowed'
        ? { contextRefs: submission.contextRefs }
        : {}),
      description: submission.description,
      priority: submission.priority,
      title: submission.title,
    };
    if (submission.ownerPrincipalRef !== undefined) {
      fields.ownerPrincipalRef = submission.ownerPrincipalRef;
    }
    if (submission.plannedHours !== undefined) {
      fields.plannedHours = submission.plannedHours;
    }
    if (submission.projectId !== undefined) {
      fields.projectId = submission.projectId;
    }
    if (submission.dueDate !== undefined) {
      fields.dueDate = submission.dueDate;
    }
    if (lookupAccess?.opportunities === 'allowed' && submission.opportunityId !== undefined) {
      fields.opportunityId = submission.opportunityId;
    }
    if (lookupAccess?.customers === 'allowed' && submission.partyId !== undefined) {
      fields.partyId = submission.partyId;
    }
    const command: WorkCommand =
      editor.mode === 'create'
        ? { _tag: 'CreateTask', ...fields }
        : {
            _tag: 'UpdateTask',
            ...Struct.omit(fields, ['ownerPrincipalRef']),
            ...assignmentPatch(editor.task.ownerPrincipalRef, submission.ownerPrincipalRef),
            // An edit always sends the due date, replacing the create-shaped one: None removes a saved date.
            dueDate: Option.fromUndefinedOr(submission.dueDate),
            plannedHours: Option.fromUndefinedOr(submission.plannedHours),
            projectId: Option.fromUndefinedOr(submission.projectId),
            taskRef: editor.task.ref,
          };
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
    // Wire `null` clears the assignment; other values must be a governed candidate.
    const ownerPrincipalRef =
      value === NONE ? Option.none() : Option.fromUndefinedOr(selectedPrincipal(principals, value));
    if (value !== NONE && Option.isNone(ownerPrincipalRef)) {
      setActionError(t(`${key}.invalid`));
      return;
    }
    setBulkBusy(true);
    setActionError(undefined);
    runCommand({ _tag: 'BulkAssignTasks', ids: selectedIds, ownerPrincipalRef }, records.revision, (outcome) =>
      finishBulk(outcome, 'assigned'),
    );
  };

  // Row start and complete. Only transitions the table allows are offered, so the server accepts them. The status
  // cell changes at once; the saved task replaces it when the command answers, and a failure puts the old one back.
  // Start and complete wait for the answer, so a second click cannot race the first against the same revision.
  const handleChangeRowState = (task: Task, toState: TaskState) => {
    if (records === undefined) {
      return;
    }
    const putRow = (row: Task) => taskRecords.update(input, (current) => withSavedTask(current, row, current.revision));
    setActionError(undefined);
    setRowBusy(true);
    putRow({ ...task, state: toState });
    runCommand({ _tag: 'ChangeTaskState', state: toState, taskRef: task.ref }, records.revision, (outcome) => {
      setRowBusy(false);
      if (outcome.ok) {
        toaster.create({
          duration: SUCCESS_TOAST_DURATION_MS,
          title: t(toState === 'DONE' ? `${key}.completed` : `${key}.started`),
          type: 'success',
        });
      } else {
        putRow(task);
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
    refreshInBackground();
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
    actorName,
    bulkBusy,
    canWrite,
    closedRowsShown,
    contextLabels,
    customerNames,
    customers,
    editor,
    principalNames,
    principals,
    filters,
    filtersActive,
    formError,
    handleArchive: (archived: boolean) => {
      if (editor?.mode !== 'edit' || records === undefined) return;
      setSaving(true);
      setFormError(undefined);
      runCommand({ _tag: 'SetTaskArchived', archived, taskRef: editor.task.ref }, records.revision, (outcome) => {
        setSaving(false);
        if (outcome.ok) {
          toaster.create({
            duration: SUCCESS_TOAST_DURATION_MS,
            title: t(archived ? `${key}.archivedToast` : `${key}.restoredToast`),
            type: 'success',
          });
        } else setFormError(outcome.message);
      });
    },
    handleBulkAssign,
    handleBulkChangeState,
    handleChangeRowState,
    handleChangeTab,
    handleClearFilters: () => handleFiltersChange(initialTaskFilters),
    handleCloseEditor,
    handleComment: (text: string) => {
      if (editor?.mode !== 'edit' || records === undefined) return;
      setSaving(true);
      runCommand({ _tag: 'AddTaskComment', taskRef: editor.task.ref, text }, records.revision, (outcome) => {
        setSaving(false);
        if (!outcome.ok) setFormError(outcome.message);
      });
    },
    handleFiltersChange,
    handleOpenCreate,
    handleOpenEdit,
    handlePlanning: (command: WorkCommand, onDone: (outcome: CommandOutcome) => void) => {
      if (records !== undefined) {
        runCommand(command, records.revision, onDone);
      }
    },
    handleReload,
    handleSave: save,
    handleSelectionChange: setSelection,
    handleSortingChange: setSorting,
    loadState,
    lookupAccess,
    lookups,
    mineName,
    objects,
    opportunities,
    opportunityTitles,
    records,
    referenceFailed,
    rowBusy,
    saving,
    selectedIds,
    selection,
    setShowHidden,
    showHidden,
    sorting,
    stateTargets,
    t,
    tab,
    today,
    visibleTasks,
  };
};

const taskStatCount = (records: RecordsResponse | undefined, countRows: (items: readonly Task[]) => number) =>
  records === undefined ? undefined : countRows(records.items);

const TasksPageContent = ({
  invalidFilter,
  legalEntityId,
  partyId,
}: {
  readonly invalidFilter: boolean;
  readonly legalEntityId: string;
  readonly partyId: typeof PartyIdSchema.Type | undefined;
}) => {
  const model = useTasksPage(legalEntityId, partyId, invalidFilter);
  const { t } = model;
  const { records } = model;
  const columns = buildTaskColumns({
    customerNames: model.customerNames,
    principalNames: model.principalNames,
    lookupAccess: model.lookupAccess,
    lookups: model.lookups,
    opportunityTitles: model.opportunityTitles,
    t,
    today: model.today,
  });
  const selectedCount = model.selectedIds.length;
  const narrow = useNarrowViewport();
  const [planningOpen, setPlanningOpen] = useState(false);

  if (invalidFilter) {
    return <StatusText status="error">{t(`${key}.invalidFilter`)}</StatusText>;
  }

  return (
    <>
      <UltramodernRouteHead />
      <PageHeader
        actions={
          model.canWrite ? (
            <div className="flex flex-wrap gap-100">
              {records !== undefined && (
                <Button onClick={() => setPlanningOpen((open) => !open)} size="sm" theme="outlined" variant="secondary">
                  {planningOpen ? 'Skrýt plánování' : 'Projekty a kapacity'}
                </Button>
              )}
              <Button onClick={model.handleOpenCreate} size="sm" variant="primary">
                {t(`${key}.newTask`)}
              </Button>
            </div>
          ) : undefined
        }
        description={t(`${key}.pageDescription`)}
        title={t(`${key}.title`)}
      />

      {planningOpen && records !== undefined && (
        <WorkPlanning
          actorName={model.actorName}
          apply={model.handlePlanning}
          openTask={model.handleOpenEdit}
          principalNames={model.principalNames}
          principals={model.principals}
          records={records}
        />
      )}

      {partyId !== undefined && (
        <p className="text-fg-secondary text-sm">
          {t(`${key}.relatedFilter`)}{' '}
          <a className="underline" href="?">
            {t(`${key}.clearRelatedFilter`)}
          </a>
        </p>
      )}

      <StatRow>
        <StatCard label={t(`${key}.stats.open`)} value={formatCount(records?.indicators.open)} />
        <StatCard
          label={t(`${key}.stats.overdue`)}
          value={formatCount(taskStatCount(records, (items) => overdueCount(items, model.today)))}
        />
        <StatCard
          label={t(`${key}.stats.doneThisWeek`)}
          value={formatCount(taskStatCount(records, (items) => doneThisWeek(items, model.today)))}
        />
        <StatCard
          label={t(`${key}.stats.unassigned`)}
          value={formatCount(taskStatCount(records, unassignedOpenCount))}
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

      <TaskFilterBar
        active={model.filtersActive}
        canAssign={records !== undefined}
        principals={model.principals}
        filters={model.filters}
        objects={model.objects}
        onChange={model.handleFiltersChange}
        onClear={model.handleClearFilters}
        onShowHiddenChange={model.canWrite ? model.setShowHidden : undefined}
        showHidden={model.showHidden}
      />

      {model.canWrite && (
        <TaskBulkBar
          busy={model.bulkBusy}
          canAssign={records !== undefined}
          count={selectedCount}
          principals={model.principals}
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
      {model.lookupAccess !== undefined && Object.values(model.lookupAccess).includes('denied') && (
        <p className="text-fg-secondary text-sm">{t(`${key}.restrictedLookups`)}</p>
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

      <ClosedRowsHint visible={model.closedRowsShown} />

      <DataTable
        // Completed and cancelled tasks cannot be reassigned or moved, so they are not offered for selection.
        canSelectRow={(row) => !isClosedTaskState(row.original.state)}
        // The row-selection column must stay first, so it is pinned ahead of the title.
        columnPinning={{ end: [], start: narrow ? ['__select'] : ['__select', 'title'] }}
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
          model.handleOpenEdit(row.original);
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
                  disabled: () => model.rowBusy,
                  hidden: (row) => !canTransition(row.original.state, 'IN_PROGRESS'),
                  icon: 'icon-[mdi--play-outline]',
                  id: 'start',
                  label: t(`${key}.start`),
                  onAction: (row) => model.handleChangeRowState(row.original, 'IN_PROGRESS'),
                },
                {
                  disabled: () => model.rowBusy,
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
        stickyActions={!narrow}
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
          actorName={model.actorName}
          assignmentAvailable={records !== undefined}
          busy={model.saving}
          contextLabels={model.contextLabels}
          customers={model.customers}
          customersLoading={!model.lookups.customers}
          error={model.formError}
          lookupAccess={model.lookupAccess}
          onArchive={model.canWrite ? model.handleArchive : undefined}
          onClose={model.handleCloseEditor}
          onComment={model.handleComment}
          onSubmit={model.handleSave}
          opportunities={model.opportunities}
          opportunitiesLoading={!model.lookups.opportunities}
          principalNames={model.principalNames}
          principals={model.principals}
          projects={records?.projects ?? []}
          readOnly={!model.canWrite}
          task={model.editor.mode === 'edit' ? model.editor.task : undefined}
        />
      )}
    </>
  );
};

/**
 * Rendered by the Shell with the props its `preloadPage` received; standalone it reads the query from the router.
 * One Toaster for the whole page tree: the shell mounts none, and ui-kit's toast store is per remote.
 */
export const RecordsPage = (props: Partial<ModulePageProps>) => {
  const routerSearch = useRouterState({ select: (state) => state.location.searchStr });
  const href = useRouterState({ select: (state) => state.location.href });
  const requested = requestedParty(props.search ?? routerSearch);
  return (
    <FederatedI18nBoundary
      defaultNamespace="work-tasks"
      fallbackLanguage="en"
      resources={workTasksI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <Toaster />
      <TasksPageContent
        invalidFilter={Option.isNone(requested)}
        key={href}
        legalEntityId={props.context?.legalEntityId ?? ''}
        partyId={Option.getOrUndefined(requested)}
      />
    </FederatedI18nBoundary>
  );
};

export default RecordsPage;
