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
import { WorkforceDuplicateEmail } from '../errors/workforce-duplicate-email.ts';
import {
  EmployeeDepartmentSchema,
  EmployeeEmailSchema,
  EmployeeFullNameSchema,
  EmployeeIdSchema,
  EmployeePhoneInputSchema,
  EmployeeRoleSchema,
  EmployeeSchema,
} from '../apis/records.ts';

const employeeFields = {
  active: Schema.Boolean,
  department: EmployeeDepartmentSchema,
  email: EmployeeEmailSchema,
  fullName: EmployeeFullNameSchema,
  phone: Schema.optionalKey(EmployeePhoneInputSchema),
  principalRef: Schema.optionalKey(PrincipalRefSchema),
  role: EmployeeRoleSchema,
};

/** Every field a caller may change on one Employee. Identity and timestamps are never patched. */
const employeePatchFields = {
  active: Schema.optionalKey(Schema.Boolean),
  department: Schema.optionalKey(EmployeeDepartmentSchema),
  email: Schema.optionalKey(EmployeeEmailSchema),
  fullName: Schema.optionalKey(EmployeeFullNameSchema),
  phone: Schema.optionalKey(EmployeePhoneInputSchema),
  principalRef: Schema.optionalKey(PrincipalRefSchema),
  role: Schema.optionalKey(EmployeeRoleSchema),
};

/** Bulk edits touch the organisational fields only; the bulk set is capped to keep one transaction small. */
const bulkPatchFields = {
  active: Schema.optionalKey(Schema.Boolean),
  department: Schema.optionalKey(EmployeeDepartmentSchema),
  role: Schema.optionalKey(EmployeeRoleSchema),
};

export const WorkforceCommandSchema = Schema.Union([
  Schema.TaggedStruct('CreateEmployee', {
    ...employeeFields,
    id: EmployeeIdSchema,
  }),
  Schema.TaggedStruct('UpdateEmployee', {
    id: EmployeeIdSchema,
    patch: Schema.Struct(employeePatchFields),
  }),
  Schema.TaggedStruct('BulkUpdateEmployees', {
    ids: Schema.Array(EmployeeIdSchema).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    patch: Schema.Struct(bulkPatchFields),
  }),
]);
export type WorkforceCommand = typeof WorkforceCommandSchema.Type;
export const ApplyCommandPayloadSchema = Schema.Struct({
  command: WorkforceCommandSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ApplyCommandPayload = typeof ApplyCommandPayloadSchema.Type;
/** Create and update return one Employee; a bulk update returns every Employee it changed. */
export const ApplyCommandResultSchema = Schema.Struct({
  employees: Schema.Array(EmployeeSchema),
  revision: Schema.Int,
});
export type ApplyCommandResult = typeof ApplyCommandResultSchema.Type;
export const WorkforceErrorSchema = Schema.Union([
  WorkforceScopeMismatch,
  WorkforceNotFound,
  WorkforceLifecycleConflict,
  WorkforceRevisionConflict,
  WorkforcePersistenceUnavailable,
  WorkforceReferenceUnavailable,
  WorkforceReferenceIneligible,
  WorkforcePermissionDenied,
  WorkforceDuplicateEmail,
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
export { WorkforceDuplicateEmail } from '../errors/workforce-duplicate-email.ts';
