import { Schema } from 'effect';

export class TenantModuleStateUnchangedError extends Schema.TaggedError<TenantModuleStateUnchangedError>()(
  'TenantModuleStateUnchangedError',
  {
    code: Schema.Literal('tenant_module_state_unchanged'),
    reason: Schema.String,
  }
) {}
