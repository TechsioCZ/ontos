import type { SupportRecoveryPrincipalContextResolverService } from '@app/core-runtime';
import { Effect } from 'effect';
import type {
  SupportAuthProvider,
  SupportImpersonationStore,
} from '../../api/auth/impersonation-service.ts';
import type { AuthenticationServiceContract } from '../../api/auth/service.ts';

const unconfiguredEffect = (operation: string) =>
  Effect.die(`${operation} is not configured in this test`);
// oxlint-disable-next-line effect-native/no-promise-shaped-port -- Rejection belongs to the Better Auth SDK fixture API.
const unconfiguredPromise = async (operation: string) => {
  throw new Error(`${operation} is not configured in this test`);
};

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
  // oxlint-disable-next-line effect-native/no-promise-shaped-port -- This fixture implements Better Auth's foreign Promise API.
  getSession: async () => await unconfiguredPromise('getSession'),
  // oxlint-disable-next-line effect-native/no-promise-shaped-port -- This fixture implements Better Auth's foreign Promise API.
  impersonateUser: async () => await unconfiguredPromise('impersonateUser'),
  // oxlint-disable-next-line effect-native/no-promise-shaped-port -- This fixture implements Better Auth's foreign Promise API.
  stopImpersonating: async () => await unconfiguredPromise('stopImpersonating'),
};

const storeDefaults: SupportImpersonationStore = {
  deleteRecovery: () => unconfiguredEffect('deleteRecovery'),
  deleteSession: () => unconfiguredEffect('deleteSession'),
  insertRecovery: () => unconfiguredEffect('insertRecovery'),
  loadExpiredRecovery: () => unconfiguredEffect('loadExpiredRecovery'),
  loadOriginalSession: () => unconfiguredEffect('loadOriginalSession'),
  loadRecoveries: () => unconfiguredEffect('loadRecoveries'),
  updateImpersonationSession: () => unconfiguredEffect('updateImpersonationSession'),
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
