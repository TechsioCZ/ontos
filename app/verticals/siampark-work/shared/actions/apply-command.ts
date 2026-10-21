import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema, Struct } from 'effect';
import { WorkScopeMismatch } from '../errors/work-scope-mismatch.ts';
import { WorkNotFound } from '../errors/work-not-found.ts';
import { WorkLifecycleConflict } from '../errors/work-lifecycle-conflict.ts';
import { WorkRevisionConflict } from '../errors/work-revision-conflict.ts';
import { WorkPersistenceUnavailable } from '../errors/work-persistence-unavailable.ts';
import { WorkReferenceUnavailable } from '../errors/work-reference-unavailable.ts';
import { WorkReferenceIneligible } from '../errors/work-reference-ineligible.ts';
import { WorkPermissionDenied } from '../errors/work-permission-denied.ts';
import {
  CalendarDateSchema,
  ContextRefSchema,
  EmployeeIdSchema,
  OpportunityIdSchema,
  PlannedHoursSchema,
  ProjectIdSchema,
  ProjectSchema,
  PartyIdSchema,
  TaskPrioritySchema,
  TaskSchema,
  TaskStateSchema,
} from '../apis/records.ts';
import { TaskRefSchema } from '../resources/task.ts';

/**
 * A task due date must be a plausible working year. The calendar format alone accepted typos such as 0026-02-12,
 * which the list then showed as 12.02.26.
 */
export const earliestDueDate = '2000-01-01';
export const latestDueDate = '2099-12-31';
export const isPlausibleDueDate = (value: string) => value >= earliestDueDate && value <= latestDueDate;
const DueDateSchema = CalendarDateSchema.check(
  Schema.makeFilter((value: string) => isPlausibleDueDate(value), {
    message: `Termín musí být mezi ${earliestDueDate} a ${latestDueDate}.`,
  }),
);
const editableFields = {
  plannedHours: Schema.optionalKey(PlannedHoursSchema),
  projectId: Schema.optionalKey(ProjectIdSchema),
  assigneeEmployeeId: Schema.optionalKey(EmployeeIdSchema),
  description: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(2000))),
  dueDate: Schema.optionalKey(DueDateSchema),
  opportunityId: Schema.optionalKey(OpportunityIdSchema),
  ownerPrincipalRef: Schema.optionalKey(PrincipalRefSchema),
  partyId: Schema.optionalKey(PartyIdSchema),
  priority: Schema.optionalKey(TaskPrioritySchema),
};
const bulkTaskIdsSchema = Schema.Array(TaskRefSchema.fields.resourceId).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isUnique(),
);
export const SingleWorkCommandSchema = Schema.Union([
  Schema.TaggedStruct('CreateTask', {
    ...editableFields,
    contextRefs: Schema.optionalKey(Schema.Array(ContextRefSchema).check(Schema.isMaxLength(12))),
    title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
  Schema.TaggedStruct('UpdateTask', {
    ...editableFields,
    contextRefs: Schema.optionalKey(Schema.Array(ContextRefSchema).check(Schema.isMaxLength(12))),
    plannedHours: Schema.optionalKey(Schema.OptionFromNullOr(PlannedHoursSchema)),
    projectId: Schema.optionalKey(Schema.OptionFromNullOr(ProjectIdSchema)),
    // Wire `null` removes the due date (None in the decoded model); an absent key keeps it.
    dueDate: Schema.optionalKey(Schema.OptionFromNullOr(DueDateSchema)),
    taskRef: TaskRefSchema,
    title: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  }),
  Schema.TaggedStruct('AssignTask', { ownerPrincipalRef: PrincipalRefSchema, taskRef: TaskRefSchema }),
  Schema.TaggedStruct('ChangeTaskState', { state: TaskStateSchema, taskRef: TaskRefSchema }),
]);
// Bulk commands apply each id independently: invalid ids are skipped and reported in `results`.
export const BulkWorkCommandSchema = Schema.Union([
  Schema.TaggedStruct('BulkAssignTasks', {
    // Wire `null` clears the assignee (None in the decoded model).
    assigneeEmployeeId: Schema.OptionFromNullOr(EmployeeIdSchema),
    ids: bulkTaskIdsSchema,
  }),
  Schema.TaggedStruct('BulkChangeTaskState', { ids: bulkTaskIdsSchema, toState: TaskStateSchema }),
]);
export const PlanningCommandSchema = Schema.Union([
  Schema.TaggedStruct('CreateProject', {
    ...Schema.Struct(Struct.omit(ProjectSchema.fields, ['id', 'createdAt', 'updatedAt'])).fields,
  }),
  Schema.TaggedStruct('UpdateProject', {
    ...Schema.Struct(Struct.omit(ProjectSchema.fields, ['createdAt', 'updatedAt'])).fields,
  }),
  Schema.TaggedStruct('AddTaskComment', {
    taskRef: TaskRefSchema,
    text: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  }),
]);
export type PlanningCommand = typeof PlanningCommandSchema.Type;
export const WorkCommandSchema = Schema.Union([SingleWorkCommandSchema, BulkWorkCommandSchema, PlanningCommandSchema]);
export type SingleWorkCommand = typeof SingleWorkCommandSchema.Type;
export type BulkWorkCommand = typeof BulkWorkCommandSchema.Type;
export type WorkCommand = typeof WorkCommandSchema.Type;
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: WorkCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
export const BulkSkipReasonSchema = Schema.Literals(['closed', 'invalid_transition', 'not_found']);
export type BulkSkipReason = typeof BulkSkipReasonSchema.Type;
export const BulkTaskResultSchema = Schema.Struct({
  outcome: Schema.Literals(['changed', 'skipped']),
  reason: Schema.optionalKey(BulkSkipReasonSchema),
  resourceId: TaskRefSchema.fields.resourceId,
});
export type BulkTaskResult = typeof BulkTaskResultSchema.Type;
export const ApplyCommandResultSchema = Schema.Struct({
  results: Schema.optionalKey(Schema.Array(BulkTaskResultSchema)),
  revision: Schema.Int,
  project: Schema.optionalKey(ProjectSchema),
  task: Schema.optionalKey(TaskSchema),
});
export const WorkErrorSchema = Schema.Union([
  WorkScopeMismatch,
  WorkNotFound,
  WorkLifecycleConflict,
  WorkRevisionConflict,
  WorkPersistenceUnavailable,
  WorkReferenceUnavailable,
  WorkReferenceIneligible,
  WorkPermissionDenied,
]);
export type WorkError = typeof WorkErrorSchema.Type;
export { WorkScopeMismatch } from '../errors/work-scope-mismatch.ts';
export { WorkNotFound } from '../errors/work-not-found.ts';
export { WorkLifecycleConflict } from '../errors/work-lifecycle-conflict.ts';
export { WorkRevisionConflict } from '../errors/work-revision-conflict.ts';
export { WorkPersistenceUnavailable } from '../errors/work-persistence-unavailable.ts';
export { WorkReferenceUnavailable } from '../errors/work-reference-unavailable.ts';
export { WorkReferenceIneligible } from '../errors/work-reference-ineligible.ts';
export { WorkPermissionDenied } from '../errors/work-permission-denied.ts';
