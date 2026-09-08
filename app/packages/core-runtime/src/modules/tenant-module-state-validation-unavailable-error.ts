import { Schema } from 'effect';

export class TenantModuleStateValidationUnavailableError extends Schema.TaggedError<TenantModuleStateValidationUnavailableError>()(
  'TenantModuleStateValidationUnavailableError',
  {
    code: Schema.Literal('tenant_module_state_validation_unavailable'),
    reason: Schema.String,
  }
) {}
