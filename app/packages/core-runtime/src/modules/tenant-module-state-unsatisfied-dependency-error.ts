import { Schema } from 'effect';

export class TenantModuleStateUnsatisfiedDependencyError extends Schema.TaggedError<TenantModuleStateUnsatisfiedDependencyError>()(
  'TenantModuleStateUnsatisfiedDependencyError',
  {
    code: Schema.Literal('tenant_module_state_dependency_unsatisfied'),
    reason: Schema.String,
  },
) {}
