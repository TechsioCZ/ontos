import { foldSearchText } from '@app/admin-ui';
import { DateTime, Match, Option, Result, Schema, Struct } from 'effect';
import { principalKey } from '../../../../shared/assignment.ts';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import type { BulkTaskResult, BulkWorkCommand } from '../../../../shared/actions/apply-command.ts';
import { canTransition } from '../../../../shared/actions/task-transitions.ts';
import { TaskPrioritySchema, TaskStateSchema } from '../../../../shared/apis/records.ts';
import type { ContextRef, Task, TaskState } from '../../../../shared/apis/records.ts';

export const TaskTabSchema = Schema.Literals(['mine', 'all']);
export type TaskTab = typeof TaskTabSchema.Type;

export const DueFilterSchema = Schema.Literals(['all', 'overdue', 'today', 'none']);
export type DueFilter = typeof DueFilterSchema.Type;

export interface TaskFilters {
  /** `all`, `none` (unassigned) or a principal key. */
  readonly assignee: string;
  readonly due: DueFilter;
  /** Termín od / do as ISO dates; '' leaves that end of the range open. */
  readonly dueFrom: string;
  readonly dueTo: string;
  /** `all` or the resourceId of a property or unit (Objekt). */
  readonly object: string;
  readonly priority: 'all' | Task['priority'];
  readonly search: string;
  readonly state: 'all' | Task['state'];
}

export const initialTaskFilters: TaskFilters = {
  assignee: 'all',
  due: 'all',
  dueFrom: '',
  dueTo: '',
  object: 'all',
  priority: 'all',
  search: '',
  state: 'all',
};

/** A property or unit offered by the Objekt filter. Units name their property, so a property also finds them. */
export interface ObjectOption {
  readonly id: string;
  readonly label: string;
  readonly propertyId?: string;
}

/** The task is linked to the chosen object, or to a unit of the chosen property. */
export const matchesObject = (task: Task, object: string, unitProperty: ReadonlyMap<string, string>) =>
  object === 'all' ||
  task.contextRefs.some((ref) => ref.resourceId === object || unitProperty.get(ref.resourceId) === object);

/** Termín within the inclusive range. A bound excludes tasks without a due date. */
export const matchesDueRange = (task: Task, from: string, to: string) =>
  (from === '' && to === '') ||
  (task.dueDate !== undefined && (from === '' || task.dueDate >= from) && (to === '' || task.dueDate <= to));

/** Workflow order for the State column and the bulk state menu. */
export const TASK_STATE_ORDER = [
  'NEW',
  'IN_PROGRESS',
  'WAITING',
  'DONE',
  'CANCELLED',
] as const satisfies readonly TaskState[];

/** Sort ranks by meaning: the table sorts by these, never by the internal English keys. */
export const PRIORITY_RANK = { HIGH: 2, LOW: 0, NORMAL: 1 } as const satisfies Record<Task['priority'], number>;
export const STATE_RANK = {
  CANCELLED: 4,
  DONE: 3,
  IN_PROGRESS: 1,
  NEW: 0,
  WAITING: 2,
} as const satisfies Record<TaskState, number>;

/** Czech collation: "Č" sorts after "C" and before "D", and accented letters sort with their base letter. */
export const czechCollator = new Intl.Collator('cs-CZ');

/** Target states that every given task can move to. A bulk state change applies one target to all of them. */
export const commonTransitionTargets = (tasks: readonly Task[]): readonly TaskState[] =>
  TASK_STATE_ORDER.filter((target) => tasks.length > 0 && tasks.every((task) => canTransition(task.state, target)));

/**
 * A ui-kit select item. The kit's hidden native `<option>` takes its text from `displayValue`; without it the
 * option falls back to the raw value (a principal key or `none`), which then leaks into the page text.
 */
export const selectOption = (label: string, value: string) => ({ displayValue: label, label, value });

/** Reference rows the page loads for names and pickers. Structural, so other verticals' rows fit without their types. */
export interface CustomerOption {
  readonly companyId: string | null;
  readonly displayName: string | null;
  readonly partyId: string;
}

export interface OpportunityOption {
  readonly id: string;
  readonly partyId: string;
  readonly title: string;
}

const DAY_MS = 86_400_000;
const OPEN_STATES = new Set<Task['state']>(['NEW', 'IN_PROGRESS', 'WAITING']);

export const isOpenTask = (task: Task) => OPEN_STATES.has(task.state);

const todayFormat = new Intl.DateTimeFormat('en-CA', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'Europe/Prague',
  year: 'numeric',
});

/** The real current business date (Europe/Prague) as ISO `YYYY-MM-DD`. */
export const todayIsoDate = () => todayFormat.format(DateTime.toDateUtc(DateTime.nowUnsafe()));

/** Open and past its due date. Calendar dates are ISO `YYYY-MM-DD`, so string comparison orders them. */
export const isOverdue = (task: Task, today: string) =>
  isOpenTask(task) && task.dueDate !== undefined && task.dueDate < today;

export const overdueCount = (tasks: readonly Task[], today: string) =>
  tasks.filter((task) => isOverdue(task, today)).length;

/** Epoch millis of UTC midnight for an ISO calendar date. */
const calendarMillis = (isoDate: string) => {
  const [year = 1970, month = 1, day = 1] = isoDate.split('-').map(Number);
  return DateTime.toEpochMillis(DateTime.makeUnsafe({ day, month, year }));
};

/** Monday = 0 … Sunday = 6. 1970-01-01 was a Thursday. */
const mondayFirstWeekday = (millis: number) => (Math.floor(millis / DAY_MS) + 3) % 7;

const dueDateFormat = new Intl.DateTimeFormat('cs-CZ', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'UTC',
  year: 'numeric',
});

/** `31.10.2026`, the same shape the Termín field shows. Intl's `31. 10. 2026` spacing is dropped. */
export const formatDueDate = (isoDate: string) =>
  dueDateFormat
    .formatToParts(calendarMillis(isoDate))
    .flatMap((part) => (part.type === 'literal' ? [] : [part.value]))
    .join('.');

export const matchesDueFilter = (task: Task, due: DueFilter, today: string) =>
  Match.value(due).pipe(
    Match.when('all', () => true),
    Match.when('overdue', () => isOverdue(task, today)),
    Match.when('today', () => task.dueDate === today),
    Match.when('none', () => task.dueDate === undefined),
    Match.exhaustive,
  );

/** Tasks completed in the ISO week that contains today. */
export const doneThisWeek = (tasks: readonly Task[], today: string) => {
  const referenceMillis = calendarMillis(today);
  const weekStart = referenceMillis - mondayFirstWeekday(referenceMillis) * DAY_MS;
  const weekEnd = weekStart + 7 * DAY_MS;
  return tasks.filter((task) => {
    if (task.state !== 'DONE') {
      return false;
    }
    const updated = DateTime.toEpochMillis(task.updatedAt);
    return updated >= weekStart && updated < weekEnd;
  }).length;
};

export const unassignedOpenCount = (tasks: readonly Task[]) =>
  tasks.filter((task) => isOpenTask(task) && task.ownerPrincipalRef === undefined).length;

const nameMatches = (name: string, needle: string) => foldSearchText(name).includes(needle);

/** Text search and the picker share one fold, so "Novak" finds "Nováková" and "plzen" finds "Plzeň". */
const textMatches = (name: string | undefined, needle: string) => name !== undefined && nameMatches(name, needle);

/** Picker items for customers whose display name matches the typed text. Customers without a name are left out. */
export const customerOptionItems = (customers: readonly CustomerOption[], query: string) => {
  const needle = foldSearchText(query.trim());
  return customers.flatMap((customer) =>
    customer.displayName !== null && nameMatches(customer.displayName, needle)
      ? [{ label: customer.displayName, value: customer.partyId }]
      : [],
  );
};

/**
 * Picker items for opportunities: the chosen customer's ones (all of them without a customer) whose title matches
 * the typed text. The selected opportunity always stays listed, so the field shows its title even when it belongs
 * to another customer.
 */
export const opportunityOptionItems = (
  opportunities: readonly OpportunityOption[],
  { partyId, query, selectedId }: { readonly partyId: string; readonly query: string; readonly selectedId: string },
) => {
  const needle = foldSearchText(query.trim());
  return opportunities.flatMap((opportunity) =>
    opportunity.id === selectedId ||
    ((partyId === '' || opportunity.partyId === partyId) && nameMatches(opportunity.title, needle))
      ? [{ label: opportunity.title, value: opportunity.id }]
      : [],
  );
};

const noNames: ReadonlyMap<string, string> = new Map();

/** Matches the title, the customer name (Zákazník column) or the assignee name (Řešitel column). */
const matchesSearch = (
  task: Task,
  needle: string,
  names: { readonly customerNames: ReadonlyMap<string, string>; readonly principalNames: ReadonlyMap<string, string> },
) => {
  const customer = task.partyId === undefined ? undefined : names.customerNames.get(task.partyId);
  const assignee =
    task.ownerPrincipalRef === undefined ? undefined : names.principalNames.get(principalKey(task.ownerPrincipalRef));
  return foldSearchText(task.title).includes(needle) || textMatches(customer, needle) || textMatches(assignee, needle);
};

const matchesAssignee = (task: Task, assignee: string) => {
  if (assignee === 'all') {
    return true;
  }
  return assignee === 'none'
    ? task.ownerPrincipalRef === undefined
    : task.ownerPrincipalRef !== undefined && principalKey(task.ownerPrincipalRef) === assignee;
};

export const filterTasks = (
  tasks: readonly Task[],
  {
    customerNames = noNames,
    filters,
    minePrincipalRef,
    principalNames = noNames,
    tab,
    today = todayIsoDate(),
    unitProperty = noNames,
  }: {
    readonly customerNames?: ReadonlyMap<string, string>;
    readonly filters: TaskFilters;
    readonly minePrincipalRef?: PrincipalRef | undefined;
    readonly principalNames?: ReadonlyMap<string, string>;
    readonly tab: TaskTab;
    readonly today?: string;
    readonly unitProperty?: ReadonlyMap<string, string>;
  },
) => {
  const needle = foldSearchText(filters.search.trim());
  return tasks.filter(
    (task) =>
      (tab === 'all' ||
        (minePrincipalRef !== undefined &&
          task.ownerPrincipalRef !== undefined &&
          principalKey(task.ownerPrincipalRef) === principalKey(minePrincipalRef))) &&
      (needle === '' || matchesSearch(task, needle, { customerNames, principalNames })) &&
      matchesAssignee(task, filters.assignee) &&
      matchesDueFilter(task, filters.due, today) &&
      matchesDueRange(task, filters.dueFrom, filters.dueTo) &&
      matchesObject(task, filters.object, unitProperty) &&
      (filters.priority === 'all' || task.priority === filters.priority) &&
      (filters.state === 'all' || task.state === filters.state),
  );
};

/** Selects only between rows already authorized by the owner; never grants access to team tasks. */
export const defaultTaskTab = (tasks: readonly Task[], minePrincipalRef: PrincipalRef | undefined): TaskTab =>
  filterTasks(tasks, { filters: initialTaskFilters, minePrincipalRef, tab: 'mine' }).some(
    (task) => task.state !== 'DONE' && task.state !== 'CANCELLED',
  )
    ? 'mine'
    : 'all';

/**
 * The Úkoly view (tab and filters) survives a reload within the browser session. React reads the serialized
 * snapshot as an external store; its server snapshot uses defaults. Missing or full storage keeps the defaults.
 */
const StoredTaskFiltersSchema = Schema.Struct({
  assignee: Schema.String,
  due: DueFilterSchema,
  dueFrom: Schema.optionalKey(Schema.String),
  dueTo: Schema.optionalKey(Schema.String),
  object: Schema.optionalKey(Schema.String),
  priority: Schema.Union([Schema.Literal('all'), TaskPrioritySchema]),
  search: Schema.String,
  state: Schema.Union([Schema.Literal('all'), TaskStateSchema]),
});
const StoredTaskViewSchema = Schema.fromJsonString(
  Schema.Struct({ filters: StoredTaskFiltersSchema, tab: TaskTabSchema }),
);
const taskViewStorageKey = 'work-tasks.tasks.view';

const sessionStorageOrUndefined = (): Storage | undefined =>
  'sessionStorage' in globalThis ? globalThis.sessionStorage : undefined;

export interface StoredTaskView {
  readonly filters: TaskFilters;
  readonly tab: TaskTab;
}

export const storedTaskViewServerSnapshot = (): null => null;

export const storedTaskViewSnapshot = (): string | null => {
  try {
    return sessionStorageOrUndefined()?.getItem(taskViewStorageKey) ?? null;
  } catch {
    return null;
  }
};

export const taskViewFromSnapshot = (raw: string | null): StoredTaskView | undefined => {
  const stored = raw === null ? undefined : Option.getOrUndefined(Schema.decodeOption(StoredTaskViewSchema)(raw));
  // A view saved before the Objekt and Termín od/do filters existed keeps them open.
  return stored === undefined ? undefined : { ...stored, filters: { ...initialTaskFilters, ...stored.filters } };
};

const taskViewChangedEvent = 'work-tasks:task-view-changed';

export const subscribeStoredTaskView = (onChange: () => void): (() => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === taskViewStorageKey) {
      onChange();
    }
  };
  globalThis.addEventListener('storage', onStorage);
  globalThis.addEventListener(taskViewChangedEvent, onChange);
  return () => {
    globalThis.removeEventListener('storage', onStorage);
    globalThis.removeEventListener(taskViewChangedEvent, onChange);
  };
};

export const writeStoredTaskView = (view: StoredTaskView) => {
  const encoded = Schema.encodeResult(StoredTaskViewSchema)(view);
  const storage = sessionStorageOrUndefined();
  if (storage === undefined || Result.isFailure(encoded)) {
    return;
  }
  try {
    storage.setItem(taskViewStorageKey, encoded.success);
    globalThis.dispatchEvent(new Event(taskViewChangedEvent));
  } catch {
    // Storage is full or blocked: the view is simply not kept across a reload.
  }
};

interface TaskList {
  readonly items: readonly Task[];
  readonly revision: number;
}

/** The list with one saved task in place (appended when it is new), at the revision its command returned. */
export const withSavedTask = <List extends TaskList>(list: List, task: Task, revision: number): List => {
  const isSaved = (item: Task) => item.ref.resourceId === task.ref.resourceId;
  return {
    ...list,
    items: list.items.some(isSaved) ? list.items.map((item) => (isSaved(item) ? task : item)) : [...list.items, task],
    revision,
  };
};

/**
 * The list with a bulk command's changed rows applied, as the server applied them, at the revision it returned. The
 * selection clears when the command answers, so the rows change with it instead of after the reload.
 */
export const withBulkResult = <List extends TaskList>(
  list: List,
  command: BulkWorkCommand,
  results: readonly BulkTaskResult[],
  revision: number,
): List => {
  const changed = new Set(results.flatMap((item) => (item.outcome === 'changed' ? [item.resourceId] : [])));
  const apply = (task: Task): Task =>
    Match.value(command).pipe(
      Match.tag('BulkChangeTaskState', ({ toState }): Task => ({ ...task, state: toState })),
      Match.tag('BulkAssignTasks', ({ ownerPrincipalRef }) =>
        Option.match(ownerPrincipalRef, {
          onNone: (): Task => Struct.omit(task, ['ownerPrincipalRef', 'assignmentNeedsReassignment']),
          onSome: (principalRef): Task => ({
            ...Struct.omit(task, ['assignmentNeedsReassignment']),
            ownerPrincipalRef: principalRef,
          }),
        }),
      ),
      Match.exhaustive,
    );
  return {
    ...list,
    items: list.items.map((item) => (changed.has(item.ref.resourceId) ? apply(item) : item)),
    revision,
  };
};

/** References navigate to the registered owning page, never a guessed contract route. */
export const taskContextHref = (ref: ContextRef) =>
  `/cs/${ref.moduleId === 'legal.agreements' ? 'smlouvy' : 'nemovitosti'}?resourceId=${encodeURIComponent(ref.resourceId)}`;
