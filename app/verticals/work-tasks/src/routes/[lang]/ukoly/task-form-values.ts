import type { SaveOutcome, RevisionedSaveResult } from '@app/admin-ui';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import { Option, Schema } from 'effect';
import { CreateTaskCommandSchema } from '../../../../shared/actions/apply-command.ts';
import { ApplyCommandActionConflictProblemSchema } from '../../../../shared/apis/apply-command-action.ts';
import { principalKey } from '../../../../shared/assignment.ts';
import {
  ContextRefSchema,
  PlannedHoursSchema,
  ProjectIdSchema,
  TaskPrioritySchema,
} from '../../../../shared/apis/records.ts';
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

/** What the task panel's controls show: ids as typed or chosen, '' for none. */
export interface FormValues {
  readonly assigneeId: string;
  readonly contextRefs: readonly ContextRef[];
  readonly description: string;
  /** The due date as the picker shows it; '' is no due date. */
  readonly dueDate: TaskDueDate;
  readonly opportunityId: string;
  readonly partyId: string;
  readonly plannedHours: string;
  readonly priority: string;
  readonly projectId: string;
  readonly title: string;
}

export interface Decoded {
  readonly dueDate: TaskDueDate | undefined;
  readonly opportunityId: Task['opportunityId'];
  readonly ownerPrincipalRef: PrincipalRef | undefined;
  readonly partyId: Task['partyId'];
}

/** What a new task's panel opens with. */
const newTaskValues: FormValues = {
  assigneeId: '',
  contextRefs: [],
  description: '',
  dueDate: '',
  opportunityId: '',
  partyId: '',
  plannedHours: '',
  priority: 'NORMAL',
  projectId: '',
  title: '',
};

export const initialValues = (task?: Task): FormValues =>
  task === undefined
    ? newTaskValues
    : {
        assigneeId: task.ownerPrincipalRef === undefined ? '' : principalKey(task.ownerPrincipalRef),
        contextRefs: task.contextRefs,
        description: task.description ?? '',
        dueDate: task.dueDate ?? '',
        opportunityId: task.opportunityId ?? '',
        partyId: task.partyId ?? '',
        plannedHours: task.plannedHours === undefined ? '' : String(task.plannedHours),
        priority: task.priority,
        projectId: task.projectId ?? '',
        title: task.title,
      };

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
 * How a failed save of the edit panel ends: the task list moved past the draft's revision is a conflict the user
 * resolves by loading the current version; everything else (a closed task, a refusal, an outage) is a failure.
 */
export const taskSaveOutcome = (error: { readonly _tag: string }): Extract<SaveOutcome, 'conflict' | 'failed'> =>
  isConflictProblem(error) && error.code === 'work_revision_conflict' ? 'conflict' : 'failed';

/** A command parked for approval: it was accepted, but nothing has changed yet. */
export const isActionProposal = Schema.is(ActionProposalAcceptedSchema);

/**
 * How an answered save of the edit panel ends: a committed save moves the draft to the returned revision. A change parked for
 * approval is `proposed`: nothing is saved, the draft keeps its base revision and is not sent again.
 */
export const taskSaveResult = (result: { readonly revision: number } | ActionProposalAccepted): RevisionedSaveResult =>
  isActionProposal(result) ? 'proposed' : result.revision;

const ProjectSelectionSchema = Schema.Struct({ projectId: Schema.optionalKey(ProjectIdSchema) });
/** Some(undefined) clears a selection. None rejects invalid input. Project IDs are never trimmed. */
export const decodeProjectSelection = (value: string): Option.Option<Task['projectId']> =>
  Schema.decodeOption(ProjectSelectionSchema)(value === '' ? {} : { projectId: value }).pipe(
    Option.map((selection) => selection.projectId),
  );

/** The CreateTask payload's own title: trimmed, 1 to 200 characters. */
export const TaskTitleSchema = CreateTaskCommandSchema.fields.title;

const PlannedHoursSelectionSchema = Schema.Struct({ plannedHours: Schema.optionalKey(PlannedHoursSchema) });
/** Some(undefined) leaves the planned hours empty. None rejects what the payload's hours do not accept. */
const decodePlannedHours = (value: string): Option.Option<number | undefined> =>
  Schema.decodeUnknownOption(PlannedHoursSelectionSchema)(value === '' ? {} : { plannedHours: Number(value) }).pipe(
    Option.map((selection) => selection.plannedHours),
  );

/** What the form sends for a draft, decoded by the payload's own schemas; None while one of them refuses it. */
export const taskFormSubmission = (values: FormValues, decoded: Decoded): Option.Option<TaskFormSubmission> =>
  Option.all({
    plannedHours: decodePlannedHours(values.plannedHours),
    priority: Schema.decodeUnknownOption(TaskPrioritySchema)(values.priority),
    projectId: decodeProjectSelection(values.projectId),
    title: Schema.decodeUnknownOption(TaskTitleSchema)(values.title),
  }).pipe(
    Option.map(({ plannedHours, priority, projectId, title }) => ({
      contextRefs: values.contextRefs,
      description: values.description.trim(),
      dueDate: decoded.dueDate,
      opportunityId: decoded.opportunityId,
      ownerPrincipalRef: decoded.ownerPrincipalRef,
      partyId: decoded.partyId,
      plannedHours,
      priority,
      projectId,
      title,
    })),
  );
