import { Schema } from 'effect';

export class TenantModuleStateTenantMissingError extends Schema.TaggedError<TenantModuleStateTenantMissingError>()(
  'TenantModuleStateTenantMissingError',
  { code: Schema.Literal('tenant_module_state_tenant_missing'), reason: Schema.String },
) {}
