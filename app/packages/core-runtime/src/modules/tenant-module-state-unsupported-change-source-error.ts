import { Schema } from 'effect';

export class TenantModuleStateUnsupportedChangeSourceError extends Schema.TaggedError<TenantModuleStateUnsupportedChangeSourceError>()(
  'TenantModuleStateUnsupportedChangeSourceError',
  {
    code: Schema.Literal('tenant_module_state_change_source_unsupported'),
    reason: Schema.String,
  },
) {}
