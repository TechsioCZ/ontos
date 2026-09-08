import { Schema } from 'effect';

export class TenantModuleStateUnsupportedStateError extends Schema.TaggedError<TenantModuleStateUnsupportedStateError>()(
  'TenantModuleStateUnsupportedStateError',
  {
    code: Schema.Literal('tenant_module_state_unsupported'),
    reason: Schema.String,
  }
) {}
