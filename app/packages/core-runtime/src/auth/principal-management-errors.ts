import { Schema } from 'effect';
import { IdentityLifecycleConflictError } from './identity-lifecycle-conflict-error.ts';
import { IdentityPersistenceUnavailableError } from './identity-persistence-unavailable-error.ts';
import { IdentityTargetInvalidError } from './identity-target-invalid-error.ts';

export { IdentityLifecycleConflictError } from './identity-lifecycle-conflict-error.ts';
export { IdentityPersistenceUnavailableError } from './identity-persistence-unavailable-error.ts';
export { IdentityTargetInvalidError } from './identity-target-invalid-error.ts';

export const PrincipalManagementErrorSchema = Schema.Union([
  IdentityLifecycleConflictError,
  IdentityTargetInvalidError,
  IdentityPersistenceUnavailableError,
]);
export type PrincipalManagementError = Schema.Schema.Type<typeof PrincipalManagementErrorSchema>;
