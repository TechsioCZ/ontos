import { Schema } from 'effect';

export class TenantModuleStateUnknownModuleError extends Schema.TaggedError<TenantModuleStateUnknownModuleError>()(
  'TenantModuleStateUnknownModuleError',
  { code: Schema.Literal('tenant_module_state_module_unknown'), reason: Schema.String },
) {}
