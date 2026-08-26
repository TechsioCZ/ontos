/* eslint-disable max-classes-per-file -- Identity lifecycle uses one closed typed failure vocabulary. */
import { Schema } from 'effect';

export class IdentityLifecycleConflictError extends Schema.TaggedError<IdentityLifecycleConflictError>()(
  'IdentityLifecycleConflictError',
  { code: Schema.Literal('identity_lifecycle_conflict'), reason: Schema.String },
) {}

export class IdentityTargetInvalidError extends Schema.TaggedError<IdentityTargetInvalidError>()(
  'IdentityTargetInvalidError',
  { code: Schema.Literal('identity_target_invalid'), reason: Schema.String },
) {}

export class IdentityPersistenceUnavailableError extends Schema.TaggedError<IdentityPersistenceUnavailableError>()(
  'IdentityPersistenceUnavailableError',
  { code: Schema.Literal('identity_persistence_unavailable'), reason: Schema.String },
) {}

export const PrincipalManagementErrorSchema = Schema.Union([
  IdentityLifecycleConflictError,
  IdentityTargetInvalidError,
  IdentityPersistenceUnavailableError,
]);
export type PrincipalManagementError = Schema.Schema.Type<typeof PrincipalManagementErrorSchema>;
