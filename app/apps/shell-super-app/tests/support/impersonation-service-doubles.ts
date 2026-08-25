import type { SupportRecoveryPrincipalContextResolverService } from '@app/core-runtime';
import { Effect } from 'effect';
import type {
  SupportAuthProvider,
  SupportImpersonationStore,
} from '../../api/auth/impersonation-service.ts';
import type { AuthenticationServiceContract } from '../../api/auth/service.ts';

const unconfiguredEffect = (operation: string) =>
  Effect.die(`${operation} is not configured in this test`);
const unconfiguredPromise = (operation: string) =>
  Promise.reject(new Error(`${operation} is not configured in this test`));

const authenticationDefaults: AuthenticationServiceContract = {
  availableTenants: () => unconfiguredEffect('availableTenants'),
  createFixtureUser: () => unconfiguredEffect('createFixtureUser'),
  currentSession: () => unconfiguredEffect('currentSession'),
  resolveShellContext: () => unconfiguredEffect('resolveShellContext'),
  resolveTenantContext: () => unconfiguredEffect('resolveTenantContext'),
  signIn: () => unconfiguredEffect('signIn'),
  signOut: () => unconfiguredEffect('signOut'),
  switchLegalEntity: () => unconfiguredEffect('switchLegalEntity'),
  switchTenant: () => unconfiguredEffect('switchTenant'),
};

const providerDefaults: SupportAuthProvider['api'] = {
  getSession: () => unconfiguredPromise('getSession'),
  impersonateUser: () => unconfiguredPromise('impersonateUser'),
  stopImpersonating: () => unconfiguredPromise('stopImpersonating'),
};

const storeDefaults: SupportImpersonationStore = {
  deleteRecovery: () => unconfiguredPromise('deleteRecovery'),
  deleteSession: () => unconfiguredPromise('deleteSession'),
  insertRecovery: () => unconfiguredPromise('insertRecovery'),
  loadExpiredRecovery: () => unconfiguredPromise('loadExpiredRecovery'),
  loadOriginalSession: () => unconfiguredPromise('loadOriginalSession'),
  loadRecoveries: () => unconfiguredPromise('loadRecoveries'),
  updateImpersonationSession: () => unconfiguredPromise('updateImpersonationSession'),
};

const supportRecoveryDefaults: SupportRecoveryPrincipalContextResolverService = {
  resolveStoppedImpersonation: () => unconfiguredEffect('resolveStoppedImpersonation'),
};

export const makeAuthenticationServiceDouble = (
  overrides: Partial<AuthenticationServiceContract> = {},
): AuthenticationServiceContract => ({ ...authenticationDefaults, ...overrides });

export const makeSupportAuthProviderDouble = (
  overrides: Partial<SupportAuthProvider['api']> = {},
): SupportAuthProvider => ({ api: { ...providerDefaults, ...overrides } });

export const makeSupportImpersonationStoreDouble = (
  overrides: Partial<SupportImpersonationStore> = {},
): SupportImpersonationStore => ({ ...storeDefaults, ...overrides });

export const makeSupportRecoveryPrincipalDouble = (
  overrides: Partial<SupportRecoveryPrincipalContextResolverService> = {},
): SupportRecoveryPrincipalContextResolverService => ({
  ...supportRecoveryDefaults,
  ...overrides,
});
