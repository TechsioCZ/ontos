import type { AutosaveOutcome } from '@app/admin-ui';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import { Option, Schema } from 'effect';
import { ApplyCommandActionConflictProblemSchema } from '../../../../shared/apis/apply-command-action.ts';
import { principalKey } from '../../../../shared/assignment.ts';
import { ContextRefSchema, ProjectIdSchema } from '../../../../shared/apis/records.ts';
import type { ContextRef, Task } from '../../../../shared/apis/records.ts';

export type TaskDueDate = NonNullable<Task['dueDate']>;

export interface TaskFormSubmission {
  readonly contextRefs: readonly ContextRef[];
  readonly description: string;
  readonly dueDate: TaskDueDate | undefined;
  readonly opportunityId: Task['opportunityId'];
  readonly ownerPrincipalRef: PrincipalRef | undefined;
  readonly partyId: Task['partyId'];
  readonly plannedHours: number | undefined;
  readonly priority: Task['priority'];
  readonly projectId: Task['projectId'];
  readonly title: string;
}

export interface FormValues {
  readonly assigneeId: string;
  readonly contextRefs: readonly ContextRef[];
  readonly description: string;
  readonly dueDate: TaskDueDate | undefined;
  readonly opportunityId: string;
  readonly partyId: string;
  readonly plannedHours: string;
  readonly priority: Task['priority'];
  readonly projectId: string;
  readonly title: string;
}

export interface Decoded {
  readonly dueDate: TaskDueDate | undefined;
  readonly opportunityId: Task['opportunityId'];
  readonly ownerPrincipalRef: PrincipalRef | undefined;
  readonly partyId: Task['partyId'];
}

export const initialValues = (task?: Task): FormValues => ({
  assigneeId: task?.ownerPrincipalRef === undefined ? '' : principalKey(task.ownerPrincipalRef),
  contextRefs: task?.contextRefs ?? [],
  description: task?.description ?? '',
  dueDate: task?.dueDate,
  opportunityId: task?.opportunityId ?? '',
  partyId: task?.partyId ?? '',
  plannedHours: task?.plannedHours === undefined ? '' : String(task.plannedHours),
  priority: task?.priority ?? 'NORMAL',
  projectId: task?.projectId ?? '',
  title: task?.title ?? '',
});

const contextRefsEqual = Schema.toEquivalence(Schema.Array(ContextRefSchema));

/** Two drafts hold the same values; array order of the context references still matters. */
export const sameFormValues = (left: FormValues, right: FormValues) =>
  contextRefsEqual(left.contextRefs, right.contextRefs) &&
  left.assigneeId === right.assigneeId &&
  left.description === right.description &&
  left.plannedHours === right.plannedHours &&
  left.projectId === right.projectId &&
  left.dueDate === right.dueDate &&
  left.opportunityId === right.opportunityId &&
  left.partyId === right.partyId &&
  left.priority === right.priority &&
  left.title === right.title;

/** Only changes to owner-defined reference fields count as unsaved input; array order still matters. */
export const hasUnsavedInput = (values: FormValues, task?: Task) => !sameFormValues(values, initialValues(task));

const isConflictProblem = Schema.is(ApplyCommandActionConflictProblemSchema);

/**
 * How a failed autosave of the edit panel ends: the task list moved past the draft's revision is a conflict the user
 * resolves by loading the current version; everything else (a closed task, a refusal, an outage) is a failure.
 */
export const taskAutosaveOutcome = (error: { readonly _tag: string }): Exclude<AutosaveOutcome, 'saved'> =>
  isConflictProblem(error) && error.code === 'work_revision_conflict' ? 'conflict' : 'failed';

const ProjectSelectionSchema = Schema.Struct({ projectId: Schema.optionalKey(ProjectIdSchema) });
/** Some(undefined) clears a selection. None rejects invalid input. Project IDs are never trimmed. */
export const decodeProjectSelection = (value: string): Option.Option<Task['projectId']> =>
  Schema.decodeOption(ProjectSelectionSchema)(value === '' ? {} : { projectId: value }).pipe(
    Option.map((selection) => selection.projectId),
  );

export const taskFormSubmission = (values: FormValues, decoded: Decoded): Option.Option<TaskFormSubmission> => {
  if (
    values.plannedHours !== '' &&
    (!Number.isFinite(Number(values.plannedHours)) ||
      Number(values.plannedHours) < 0 ||
      Number(values.plannedHours) > 10_000)
  ) {
    return Option.none();
  }
  return decodeProjectSelection(values.projectId).pipe(
    Option.map((projectId) => ({
      contextRefs: values.contextRefs,
      description: values.description.trim(),
      dueDate: decoded.dueDate,
      opportunityId: decoded.opportunityId,
      ownerPrincipalRef: decoded.ownerPrincipalRef,
      partyId: decoded.partyId,
      plannedHours: values.plannedHours === '' ? undefined : Number(values.plannedHours),
      priority: values.priority,
      projectId,
      title: values.title.trim(),
    })),
  );
};
