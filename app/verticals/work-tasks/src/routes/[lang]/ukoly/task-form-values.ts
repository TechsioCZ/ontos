import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import { Option, Schema } from 'effect';
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

/** Only changes to owner-defined reference fields count as unsaved input; array order still matters. */
export const hasUnsavedInput = (values: FormValues, task?: Task) => {
  const initial = initialValues(task);
  return (
    !contextRefsEqual(values.contextRefs, initial.contextRefs) ||
    values.assigneeId !== initial.assigneeId ||
    values.description !== initial.description ||
    values.plannedHours !== initial.plannedHours ||
    values.projectId !== initial.projectId ||
    values.dueDate !== initial.dueDate ||
    values.opportunityId !== initial.opportunityId ||
    values.partyId !== initial.partyId ||
    values.priority !== initial.priority ||
    values.title !== initial.title
  );
};

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
