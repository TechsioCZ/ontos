import { Schema } from 'effect';

export class TenantModuleStateConcurrentChangeError extends Schema.TaggedError<TenantModuleStateConcurrentChangeError>()(
  'TenantModuleStateConcurrentChangeError',
  {
    code: Schema.Literal('tenant_module_state_changed_concurrently'),
    reason: Schema.String,
  },
) {}
