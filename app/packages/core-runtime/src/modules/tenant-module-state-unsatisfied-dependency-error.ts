import { Schema } from 'effect';

export class TenantModuleStateUnsatisfiedDependencyError extends Schema.TaggedError<TenantModuleStateUnsatisfiedDependencyError>()(
  'TenantModuleStateUnsatisfiedDependencyError',
  {
    code: Schema.Literal('tenant_module_state_dependency_unsatisfied'),
    reason: Schema.String,
  },
) {}

/** Shared sanitized failure for intrinsic metadata/state validation. */
export const unsatisfiedTenantModuleDependency = () =>
  new TenantModuleStateUnsatisfiedDependencyError({
    code: 'tenant_module_state_dependency_unsatisfied',
    reason: 'An intrinsic module dependency is absent, incompatible, or not active',
  });
