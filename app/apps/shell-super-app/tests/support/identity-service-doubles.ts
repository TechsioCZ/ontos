import type { PrincipalResolverService } from '@app/core-runtime';
import { Effect } from 'effect';
import type { ApiKeyServiceContract } from '../../api/auth/api-key-service.ts';

const unconfigured = (operation: string) =>
  Effect.die(`${operation} is not configured in this test`);

const apiKeyDefaults: ApiKeyServiceContract = {
  clearPendingCleanup: () => unconfigured('clearPendingCleanup'),
  issue: () => unconfigured('issue'),
  metadata: () => unconfigured('metadata'),
  pendingCleanup: () => unconfigured('pendingCleanup'),
  setEnabled: () => unconfigured('setEnabled'),
  verify: () => unconfigured('verify'),
};

const principalResolverDefaults: PrincipalResolverService = {
  listAvailableTenants: () => unconfigured('listAvailableTenants'),
  loadApiKeyBindingForAdministration: () => unconfigured('loadApiKeyBindingForAdministration'),
  resolveApiKeyBindingSubject: () => unconfigured('resolveApiKeyBindingSubject'),
  resolveBetterAuthApiKey: () => unconfigured('resolveBetterAuthApiKey'),
  resolveBetterAuthUserForPrincipal: () => unconfigured('resolveBetterAuthUserForPrincipal'),
  resolveBetterAuthUserForTenant: () => unconfigured('resolveBetterAuthUserForTenant'),
  resolveDefaultBetterAuthUser: () => unconfigured('resolveDefaultBetterAuthUser'),
  resolveProviderSubject: () => unconfigured('resolveProviderSubject'),
  verifySupportImpersonationStarted: () => unconfigured('verifySupportImpersonationStarted'),
};

export const makeApiKeyServiceDouble = (
  overrides: Partial<ApiKeyServiceContract> = {},
): ApiKeyServiceContract => ({ ...apiKeyDefaults, ...overrides });

export const makePrincipalResolverDouble = (
  overrides: Partial<PrincipalResolverService> = {},
): PrincipalResolverService => ({ ...principalResolverDefaults, ...overrides });
