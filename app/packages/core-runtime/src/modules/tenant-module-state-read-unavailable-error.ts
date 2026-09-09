import { Schema } from 'effect';

export class TenantModuleStateReadUnavailableError extends Schema.TaggedError<TenantModuleStateReadUnavailableError>()(
  'TenantModuleStateReadUnavailableError',
  {
    code: Schema.Literal('tenant_module_state_read_unavailable'),
    reason: Schema.String,
  },
) {}
