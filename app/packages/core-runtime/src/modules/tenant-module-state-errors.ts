import type { TenantModuleStateConcurrentChangeError } from './tenant-module-state-concurrent-change-error.ts';
import type { TenantModuleStatePersistenceUnavailableError } from './tenant-module-state-persistence-unavailable-error.ts';
import type { TenantModuleStateTenantMissingError } from './tenant-module-state-tenant-missing-error.ts';
import type { TenantModuleStateUnchangedError } from './tenant-module-state-unchanged-error.ts';
import type { TenantModuleStateUnknownModuleError } from './tenant-module-state-unknown-module-error.ts';
import type { TenantModuleStateUnsupportedChangeSourceError } from './tenant-module-state-unsupported-change-source-error.ts';
import type { TenantModuleStateUnsupportedStateError } from './tenant-module-state-unsupported-state-error.ts';
import type { TenantModuleStateValidationUnavailableError } from './tenant-module-state-validation-unavailable-error.ts';

export { TenantModuleStateConcurrentChangeError } from './tenant-module-state-concurrent-change-error.ts';
export { TenantModuleStatePersistenceUnavailableError } from './tenant-module-state-persistence-unavailable-error.ts';
export { TenantModuleStateReadUnavailableError } from './tenant-module-state-read-unavailable-error.ts';
export { TenantModuleStateTenantMissingError } from './tenant-module-state-tenant-missing-error.ts';
export { TenantModuleStateUnchangedError } from './tenant-module-state-unchanged-error.ts';
export { TenantModuleStateUnknownModuleError } from './tenant-module-state-unknown-module-error.ts';
export { TenantModuleStateUnsupportedChangeSourceError } from './tenant-module-state-unsupported-change-source-error.ts';
export { TenantModuleStateUnsupportedStateError } from './tenant-module-state-unsupported-state-error.ts';
export { TenantModuleStateValidationUnavailableError } from './tenant-module-state-validation-unavailable-error.ts';

export type TenantModuleStateTransitionError =
  | TenantModuleStateConcurrentChangeError
  | TenantModuleStatePersistenceUnavailableError
  | TenantModuleStateTenantMissingError
  | TenantModuleStateUnchangedError
  | TenantModuleStateUnsupportedChangeSourceError
  | TenantModuleStateUnknownModuleError
  | TenantModuleStateUnsupportedStateError
  | TenantModuleStateValidationUnavailableError;
