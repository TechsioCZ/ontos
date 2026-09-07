import type { PrincipalBindingAmbiguousError } from './principal-binding-ambiguous-error.ts';
import type { PrincipalBindingInactiveError } from './principal-binding-inactive-error.ts';
import type { PrincipalBindingMissingError } from './principal-binding-missing-error.ts';
import type { PrincipalInactiveError } from './principal-inactive-error.ts';
import type { PrincipalResolverUnavailableError } from './principal-resolver-unavailable-error.ts';
import type { TenantInactiveError } from './tenant-inactive-error.ts';

export { PrincipalBindingAmbiguousError } from './principal-binding-ambiguous-error.ts';
export { PrincipalBindingInactiveError } from './principal-binding-inactive-error.ts';
export { PrincipalBindingMissingError } from './principal-binding-missing-error.ts';
export { PrincipalInactiveError } from './principal-inactive-error.ts';
export { PrincipalResolverUnavailableError } from './principal-resolver-unavailable-error.ts';
export { TenantInactiveError } from './tenant-inactive-error.ts';

export type PrincipalResolutionError =
  | PrincipalBindingMissingError
  | PrincipalBindingAmbiguousError
  | PrincipalBindingInactiveError
  | PrincipalInactiveError
  | TenantInactiveError
  | PrincipalResolverUnavailableError;
