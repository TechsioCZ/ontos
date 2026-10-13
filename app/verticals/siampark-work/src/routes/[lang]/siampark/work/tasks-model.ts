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

export interface Viewer {
  readonly employeeId: string | undefined;
  readonly principalId: string;
}

const DAY_MS = 86_400_000;
const OPEN_STATES = new Set<Task['state']>(['NEW', 'IN_PROGRESS', 'WAITING']);

export const isOpenTask = (task: Task) => OPEN_STATES.has(task.state);

/** Calendar dates are ISO `YYYY-MM-DD`, so string comparison orders them correctly. */
export const isOverdue = (task: Task, referenceDate: string) =>
  isOpenTask(task) && task.dueDate !== undefined && task.dueDate < referenceDate;

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

/** Tasks completed in the ISO week that contains the reference date. */
export const doneThisWeek = (tasks: readonly Task[], referenceDate: string) => {
  const referenceMillis = calendarMillis(referenceDate);
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
 * "Moje úkoly": the employee whose principal is the current user. If no employee matches,
 * fall back to the task owner principal, as the page did before employees existed.
 */
export const viewerOf = (actorPrincipalId: string, employees: readonly Employee[]): Viewer => ({
  employeeId: employees.find((employee) => employee.principalRef?.principalId === actorPrincipalId)?.id,
  principalId: actorPrincipalId,
});

export const isMine = (task: Task, viewer: Viewer) =>
  viewer.employeeId === undefined
    ? task.ownerPrincipalRef?.principalId === viewer.principalId
    : task.assigneeEmployeeId === viewer.employeeId;

const matchesAssignee = (task: Task, assignee: string) => {
  if (assignee === 'all') {
    return true;
  }
  return assignee === 'none' ? task.assigneeEmployeeId === undefined : task.assigneeEmployeeId === assignee;
};

export const filterTasks = (
  tasks: readonly Task[],
  { filters, tab, viewer }: { readonly filters: TaskFilters; readonly tab: TaskTab; readonly viewer: Viewer },
) => {
  const needle = filters.search.trim().toLocaleLowerCase('cs-CZ');
  return tasks.filter(
    (task) =>
      (tab === 'all' || isMine(task, viewer)) &&
      (needle === '' || task.title.toLocaleLowerCase('cs-CZ').includes(needle)) &&
      matchesAssignee(task, filters.assignee) &&
      (filters.priority === 'all' || task.priority === filters.priority) &&
      (filters.state === 'all' || task.state === filters.state),
  );
};
