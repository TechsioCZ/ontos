import type { DateTime } from 'effect';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import type { Change, HistoryEntry, Task, WorkProject, WorkState } from '../../shared/apis/records.ts';

/** Older entries drop off first, so one long-lived task cannot grow the company row without bound. */
const historyLimit = 100;

const text = (value: string | number | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : String(value);

/** Field name → saved value as text; absent when the field is empty. */
type FieldValues = ReadonlyMap<string, string | undefined>;

/** The saved values a person recognises in the editor, as strings. Ids stay ids: the editor names them. */
const taskValues = (task: Task): FieldValues =>
  new Map([
    ['title', task.title],
    ['description', text(task.description)],
    ['state', task.state],
    ['priority', task.priority],
    ['dueDate', task.dueDate],
    ['assigneeEmployeeId', task.assigneeEmployeeId],
    ['partyId', task.partyId],
    ['opportunityId', task.opportunityId],
    ['projectId', task.projectId],
    ['plannedHours', text(task.plannedHours)],
    [
      'contextRefs',
      task.contextRefs.length === 0
        ? undefined
        : task.contextRefs.map((ref) => `${ref.resourceType}:${ref.resourceId}`).join(','),
    ],
  ]);

const projectValues = (project: WorkProject): FieldValues =>
  new Map([
    ['title', project.title],
    ['plannedStart', project.plannedStart],
    ['plannedEnd', project.plannedEnd],
    ['responsibleEmployeeId', project.responsibleEmployeeId],
    ['state', project.state],
    [
      'milestones',
      project.milestones.length === 0
        ? undefined
        : project.milestones
            .map((milestone) => `${milestone.title} (${milestone.dueDate}${milestone.completed ? ', hotovo' : ''})`)
            .join('; '),
    ],
  ]);

const diff = (before: FieldValues | undefined, after: FieldValues): Change[] =>
  [...after].flatMap(([field, value]) => {
    const previous = before?.get(field);
    if (previous === value) return [];
    const change: { field: string; before?: string; after?: string } = { field };
    if (previous !== undefined) change.before = previous;
    if (value !== undefined) change.after = value;
    return [change];
  });

const append = (history: readonly HistoryEntry[] | undefined, entry: HistoryEntry) =>
  [...(history ?? []), entry].slice(-historyLimit);

/**
 * The state with one history entry on every task and project the command created or changed. Entries carry the
 * acting principal, the time and each changed field before → after. A change that only adds a comment adds none.
 */
export const withHistory = (before: WorkState, after: WorkState, actor: PrincipalRef, now: DateTime.Utc): WorkState => {
  const previousTasks = new Map(before.tasks.map((task) => [task.ref.resourceId, task] as const));
  const tasks = after.tasks.map((task): Task => {
    const previous = previousTasks.get(task.ref.resourceId);
    if (previous === task) return task;
    const changes = diff(previous === undefined ? undefined : taskValues(previous), taskValues(task));
    const archivedChanged = (previous?.archivedAt === undefined) !== (task.archivedAt === undefined);
    if (previous !== undefined && changes.length === 0 && !archivedChanged) return task;
    const action =
      previous === undefined
        ? ('created' as const)
        : archivedChanged
          ? task.archivedAt === undefined
            ? ('restored' as const)
            : ('archived' as const)
          : ('updated' as const);
    return { ...task, history: append(previous?.history, { action, actorPrincipalRef: actor, at: now, changes }) };
  });
  const previousProjects = new Map((before.projects ?? []).map((project) => [project.id, project] as const));
  const projects = after.projects?.map((project): WorkProject => {
    const previous = previousProjects.get(project.id);
    if (previous === project) return project;
    const changes = diff(previous === undefined ? undefined : projectValues(previous), projectValues(project));
    if (previous !== undefined && changes.length === 0)
      return previous.history === undefined ? project : { ...project, history: previous.history };
    return {
      ...project,
      history: append(previous?.history, {
        action: previous === undefined ? 'created' : 'updated',
        actorPrincipalRef: actor,
        at: now,
        changes,
      }),
    };
  });
  return projects === undefined ? { ...after, tasks } : { ...after, projects, tasks };
};
