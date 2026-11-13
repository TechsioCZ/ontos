import type { TenantModuleStateService } from '@app/core-runtime';
import { Effect } from 'effect';

/**
 * Tenant module state for paths that must never read it (agent lifecycle withdrawals read no module state): any read
 * fails the test loudly instead of answering.
 */
const UNEXPECTED_READ = 'Unexpected tenant module state read';

export const unusedModuleState: TenantModuleStateService['Service'] = {
  getTenantModuleStates: () => Effect.die(UNEXPECTED_READ),
  listActiveTenantModules: () => Effect.die(UNEXPECTED_READ),
  listTenantModuleStates: () => Effect.die(UNEXPECTED_READ),
};
