import { rs } from 'effect-rstest';
import { Effect } from 'effect';
import type {
  SupportAuthProvider,
  SupportImpersonationStore,
} from '../../api/auth/impersonation-service.ts';
import type { AuthenticationServiceContract } from '../../api/auth/service.ts';

const unconfiguredEffect = (operation: string) =>
  Effect.die(`${operation} is not configured in this test`);
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
  getSession: rs
    .fn<SupportAuthProvider['api']['getSession']>()
    .mockRejectedValue(new Error('getSession is not configured in this test')),
  impersonateUser: rs
    .fn<SupportAuthProvider['api']['impersonateUser']>()
    .mockRejectedValue(new Error('impersonateUser is not configured in this test')),
  stopImpersonating: rs
    .fn<SupportAuthProvider['api']['stopImpersonating']>()
    .mockRejectedValue(new Error('stopImpersonating is not configured in this test')),
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
