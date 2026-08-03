/* eslint-disable max-classes-per-file -- One closed Core module-state failure vocabulary. */
import { Schema } from 'effect';

export class TenantModuleStateReadUnavailableError extends Schema.TaggedErrorClass<TenantModuleStateReadUnavailableError>()(
  'TenantModuleStateReadUnavailableError',
  {
    code: Schema.Literal('tenant_module_state_read_unavailable'),
    reason: Schema.String,
  },
) {}

export class TenantModuleStatePersistenceUnavailableError extends Schema.TaggedErrorClass<TenantModuleStatePersistenceUnavailableError>()(
  'TenantModuleStatePersistenceUnavailableError',
  {
    code: Schema.Literal('tenant_module_state_persistence_unavailable'),
    reason: Schema.String,
  },
) {}

export class TenantModuleStateTenantMissingError extends Schema.TaggedErrorClass<TenantModuleStateTenantMissingError>()(
  'TenantModuleStateTenantMissingError',
  {
    code: Schema.Literal('tenant_module_state_tenant_missing'),
    reason: Schema.String,
  },
) {}

export class TenantModuleStateUnchangedError extends Schema.TaggedErrorClass<TenantModuleStateUnchangedError>()(
  'TenantModuleStateUnchangedError',
  {
    code: Schema.Literal('tenant_module_state_unchanged'),
    reason: Schema.String,
  },
) {}

export class TenantModuleStateConcurrentChangeError extends Schema.TaggedErrorClass<TenantModuleStateConcurrentChangeError>()(
  'TenantModuleStateConcurrentChangeError',
  {
    code: Schema.Literal('tenant_module_state_changed_concurrently'),
    reason: Schema.String,
  },
) {}

export class TenantModuleStateUnsupportedChangeSourceError extends Schema.TaggedErrorClass<TenantModuleStateUnsupportedChangeSourceError>()(
  'TenantModuleStateUnsupportedChangeSourceError',
  {
    code: Schema.Literal('tenant_module_state_change_source_unsupported'),
    reason: Schema.String,
  },
) {}

export type TenantModuleStateTransitionError =
  | TenantModuleStateConcurrentChangeError
  | TenantModuleStatePersistenceUnavailableError
  | TenantModuleStateTenantMissingError
  | TenantModuleStateUnchangedError
  | TenantModuleStateUnsupportedChangeSourceError;
