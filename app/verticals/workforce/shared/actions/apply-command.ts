import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { Schema } from 'effect';
import { WorkforceScopeMismatch } from '../errors/workforce-scope-mismatch.ts';
import { WorkforceNotFound } from '../errors/workforce-not-found.ts';
import { WorkforceLifecycleConflict } from '../errors/workforce-lifecycle-conflict.ts';
import { WorkforceRevisionConflict } from '../errors/workforce-revision-conflict.ts';
import { WorkforcePersistenceUnavailable } from '../errors/workforce-persistence-unavailable.ts';
import { WorkforceReferenceUnavailable } from '../errors/workforce-reference-unavailable.ts';
import { WorkforceReferenceIneligible } from '../errors/workforce-reference-ineligible.ts';
import { WorkforcePermissionDenied } from '../errors/workforce-permission-denied.ts';
import {
  CalendarDateSchema,
  ContextRefSchema,
  EmployeePrioritySchema,
  EmployeeSchema,
  EmployeeStateSchema,
} from '../apis/records.ts';
import { EmployeeRefSchema } from '../resources/employee.ts';

const editableFields = {
  description: Schema.optionalKey(Schema.Trim.check(Schema.isMaxLength(2000))),
  dueDate: Schema.optionalKey(CalendarDateSchema),
  ownerPrincipalRef: Schema.optionalKey(PrincipalRefSchema),
  priority: Schema.optionalKey(EmployeePrioritySchema),
};
export const WorkforceCommandSchema = Schema.Union([
  Schema.TaggedStruct('CreateEmployee', {
    ...editableFields,
    contextRefs: Schema.optionalKey(Schema.Array(ContextRefSchema).check(Schema.isMaxLength(12))),
    title: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
  Schema.TaggedStruct('UpdateEmployee', {
    ...editableFields,
    employeeRef: EmployeeRefSchema,
    title: Schema.optionalKey(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  }),
  Schema.TaggedStruct('AssignEmployee', { employeeRef: EmployeeRefSchema, ownerPrincipalRef: PrincipalRefSchema }),
  Schema.TaggedStruct('ChangeEmployeeState', { employeeRef: EmployeeRefSchema, state: EmployeeStateSchema }),
]);
export type WorkforceCommand = typeof WorkforceCommandSchema.Type;
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: WorkforceCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
export const ApplyCommandResultSchema = Schema.Struct({ employee: EmployeeSchema, revision: Schema.Int });
export const WorkforceErrorSchema = Schema.Union([
  WorkforceScopeMismatch,
  WorkforceNotFound,
  WorkforceLifecycleConflict,
  WorkforceRevisionConflict,
  WorkforcePersistenceUnavailable,
  WorkforceReferenceUnavailable,
  WorkforceReferenceIneligible,
  WorkforcePermissionDenied,
]);
export type WorkforceError = typeof WorkforceErrorSchema.Type;
export { WorkforceScopeMismatch } from '../errors/workforce-scope-mismatch.ts';
export { WorkforceNotFound } from '../errors/workforce-not-found.ts';
export { WorkforceLifecycleConflict } from '../errors/workforce-lifecycle-conflict.ts';
export { WorkforceRevisionConflict } from '../errors/workforce-revision-conflict.ts';
export { WorkforcePersistenceUnavailable } from '../errors/workforce-persistence-unavailable.ts';
export { WorkforceReferenceUnavailable } from '../errors/workforce-reference-unavailable.ts';
export { WorkforceReferenceIneligible } from '../errors/workforce-reference-ineligible.ts';
export { WorkforcePermissionDenied } from '../errors/workforce-permission-denied.ts';
