import { DateTime, Schema } from 'effect';
import type { Employee } from '@app/workforce/contracts/records';
import type { Task } from '../../../../../shared/apis/records.ts';

export const TaskTabSchema = Schema.Literals(['mine', 'all']);
export type TaskTab = typeof TaskTabSchema.Type;

export interface TaskFilters {
  /** `all`, `none` (unassigned) or an employee id. */
  readonly assignee: string;
  readonly priority: 'all' | Task['priority'];
  readonly search: string;
  readonly state: 'all' | Task['state'];
}

export const initialTaskFilters: TaskFilters = { assignee: 'all', priority: 'all', search: '', state: 'all' };

/**
 * A ui-kit select item. The kit's hidden native `<option>` takes its text from `displayValue`; without it the
 * option falls back to the raw value (an employee id or `none`), which then leaks into the page text.
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
  day: 'numeric',
  month: 'numeric',
  timeZone: 'UTC',
  year: 'numeric',
});

export const formatDueDate = (isoDate: string) => dueDateFormat.format(calendarMillis(isoDate));

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
  tasks.filter((task) => isOpenTask(task) && task.assigneeEmployeeId === undefined).length;

/**
 * "Moje úkoly": the employee bound to the signed-in principal. Undefined when no employee carries that
 * principal, so "mine" cannot narrow the list and the page shows every task with a note instead.
 */
export const employeeIdOf = (actorPrincipalId: string, employees: readonly Employee[]) =>
  employees.find((employee) => employee.principalRef?.principalId === actorPrincipalId)?.id;

/** Lower case with diacritics removed, so a search without háčky or čárky ("uklid") finds "Úklid". */
const foldSearchText = (text: string) => text.normalize('NFD').replaceAll(/\p{M}/gu, '').toLocaleLowerCase('cs-CZ');

const matchesSearch = (task: Task, needle: string) => foldSearchText(task.title).includes(needle);

const matchesAssignee = (task: Task, assignee: string) => {
  if (assignee === 'all') {
    return true;
  }
  return assignee === 'none' ? task.assigneeEmployeeId === undefined : task.assigneeEmployeeId === assignee;
};

export const filterTasks = (
  tasks: readonly Task[],
  {
    filters,
    mineEmployeeId,
    tab,
  }: {
    readonly filters: TaskFilters;
    readonly mineEmployeeId: string | undefined;
    readonly tab: TaskTab;
  },
) => {
  const needle = foldSearchText(filters.search.trim());
  return tasks.filter(
    (task) =>
      (tab === 'all' || mineEmployeeId === undefined || task.assigneeEmployeeId === mineEmployeeId) &&
      (needle === '' || matchesSearch(task, needle)) &&
      matchesAssignee(task, filters.assignee) &&
      (filters.priority === 'all' || task.priority === filters.priority) &&
      (filters.state === 'all' || task.state === filters.state),
  );
};
