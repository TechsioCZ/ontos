import { Effect } from 'effect';
import type {
  SupportAuthProvider,
  SupportImpersonationStore,
} from '../../api/auth/impersonation-service.ts';
import type { AuthenticationServiceContract } from '../../api/auth/service.ts';

const unconfiguredEffect = (operation: string) =>
  Effect.die(`${operation} is not configured in this test`);
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
  getSession: async () => await unconfiguredPromise('getSession'),
  impersonateUser: async () => await unconfiguredPromise('impersonateUser'),
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

export const makeAuthenticationServiceDouble = (
  overrides: Partial<AuthenticationServiceContract> = {},
): AuthenticationServiceContract => ({ ...authenticationDefaults, ...overrides });

export const makeSupportAuthProviderDouble = (
  overrides: Partial<SupportAuthProvider['api']> = {},
): SupportAuthProvider => ({ api: { ...providerDefaults, ...overrides } });

export const makeSupportImpersonationStoreDouble = (
  overrides: Partial<SupportImpersonationStore> = {},
): SupportImpersonationStore => ({ ...storeDefaults, ...overrides });
