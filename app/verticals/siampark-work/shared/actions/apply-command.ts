import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';
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
  TaskPrioritySchema,
  TaskSchema,
  TaskStateSchema,
} from '../apis/records.ts';
import { TaskRefSchema } from '../resources/task.ts';

const editableFields = {
  description: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(2000))),
  dueDate: Schema.optionalKey(CalendarDateSchema),
  ownerPrincipalRef: Schema.optionalKey(PrincipalRefSchema),
  priority: Schema.optionalKey(TaskPrioritySchema),
};
export const WorkCommandSchema = Schema.Union([
  Schema.TaggedStruct('CreateTask', {
    ...editableFields,
    contextRefs: Schema.optionalKey(Schema.Array(ContextRefSchema).check(Schema.isMaxLength(12))),
    title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
  Schema.TaggedStruct('UpdateTask', {
    ...editableFields,
    taskRef: TaskRefSchema,
    title: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  }),
  Schema.TaggedStruct('AssignTask', { ownerPrincipalRef: PrincipalRefSchema, taskRef: TaskRefSchema }),
  Schema.TaggedStruct('ChangeTaskState', { state: TaskStateSchema, taskRef: TaskRefSchema }),
]);
export type WorkCommand = typeof WorkCommandSchema.Type;
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: WorkCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
export const ApplyCommandResultSchema = Schema.Struct({ revision: Schema.Int, task: TaskSchema });
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
