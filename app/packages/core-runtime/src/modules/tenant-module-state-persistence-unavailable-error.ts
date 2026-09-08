import { Schema } from 'effect';

export class TenantModuleStatePersistenceUnavailableError extends Schema.TaggedError<TenantModuleStatePersistenceUnavailableError>()(
  'TenantModuleStatePersistenceUnavailableError',
  {
    code: Schema.Literal('tenant_module_state_persistence_unavailable'),
    reason: Schema.String,
  }
) {}
