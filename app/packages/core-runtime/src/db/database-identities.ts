import { Option } from 'effect';

import { DATABASE_IDENTITIES } from './database-identity-manifest.ts';

export {
  BEARER_ASSERTION_ROLE_SETTINGS,
  DATABASE_IDENTITIES,
  DEDICATED_IDENTITY_MODULE_KEYS,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  PARTY_REGISTRY_WORKER_IDENTITY,
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  TRUST_ROUTINES,
} from './database-identity-manifest.ts';
export type {
  DatabaseAcceptedFinding,
  DatabaseIdentity,
  DatabaseRoleGrants,
  DatabaseScopeAuthority,
  DatabaseTableGrant,
  DatabaseTablePrivilege,
} from './database-identity-manifest.ts';

export const gatewayScopeGrantRoleForAudience = (audience: string): Option.Option<string> =>
  Option.fromUndefinedOr(
    DATABASE_IDENTITIES.find(
      (identity) => identity.scopeAuthority === 'gateway_grant' && identity.gatewayScopeAudiences.includes(audience),
    )?.role,
  );
