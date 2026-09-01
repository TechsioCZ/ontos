/* eslint-disable max-classes-per-file -- One closed Core module-state failure vocabulary. */
import { Schema } from 'effect';

export class TenantModuleStateReadUnavailableError extends Schema.TaggedError<TenantModuleStateReadUnavailableError>()(
  'TenantModuleStateReadUnavailableError',
  {
    code: Schema.Literal('tenant_module_state_read_unavailable'),
    reason: Schema.String,
  },
) {}

export class TenantModuleStatePersistenceUnavailableError extends Schema.TaggedError<TenantModuleStatePersistenceUnavailableError>()(
  'TenantModuleStatePersistenceUnavailableError',
  {
    code: Schema.Literal('tenant_module_state_persistence_unavailable'),
    reason: Schema.String,
  },
) {}

export class TenantModuleStateTenantMissingError extends Schema.TaggedError<TenantModuleStateTenantMissingError>()(
  'TenantModuleStateTenantMissingError',
  {
    code: Schema.Literal('tenant_module_state_tenant_missing'),
    reason: Schema.String,
  },
) {}

export class TenantModuleStateUnchangedError extends Schema.TaggedError<TenantModuleStateUnchangedError>()(
  'TenantModuleStateUnchangedError',
  {
    code: Schema.Literal('tenant_module_state_unchanged'),
    reason: Schema.String,
  },
) {}

export class TenantModuleStateConcurrentChangeError extends Schema.TaggedError<TenantModuleStateConcurrentChangeError>()(
  'TenantModuleStateConcurrentChangeError',
  {
    code: Schema.Literal('tenant_module_state_changed_concurrently'),
    reason: Schema.String,
  },
) {}

export class TenantModuleStateUnsupportedChangeSourceError extends Schema.TaggedError<TenantModuleStateUnsupportedChangeSourceError>()(
  'TenantModuleStateUnsupportedChangeSourceError',
  {
    code: Schema.Literal('tenant_module_state_change_source_unsupported'),
    reason: Schema.String,
  },
) {}

export class TenantModuleStateUnknownModuleError extends Schema.TaggedError<TenantModuleStateUnknownModuleError>()(
  'TenantModuleStateUnknownModuleError',
  {
    code: Schema.Literal('tenant_module_state_module_unknown'),
    reason: Schema.String,
  },
) {}

export class TenantModuleStateUnsupportedStateError extends Schema.TaggedError<TenantModuleStateUnsupportedStateError>()(
  'TenantModuleStateUnsupportedStateError',
  {
    code: Schema.Literal('tenant_module_state_unsupported'),
    reason: Schema.String,
  },
) {}

export class TenantModuleStateValidationUnavailableError extends Schema.TaggedError<TenantModuleStateValidationUnavailableError>()(
  'TenantModuleStateValidationUnavailableError',
  {
    code: Schema.Literal('tenant_module_state_validation_unavailable'),
    reason: Schema.String,
  },
) {}

export type TenantModuleStateTransitionError =
  | TenantModuleStateConcurrentChangeError
  | TenantModuleStatePersistenceUnavailableError
  | TenantModuleStateTenantMissingError
  | TenantModuleStateUnchangedError
  | TenantModuleStateUnsupportedChangeSourceError
  | TenantModuleStateUnknownModuleError
  | TenantModuleStateUnsupportedStateError
  | TenantModuleStateValidationUnavailableError;
