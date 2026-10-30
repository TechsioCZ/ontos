import { Context, Layer, Option } from 'effect';

import type { DatabaseIdentityEnrollment } from './database-identity-manifest.ts';

export {
  BEARER_ASSERTION_ROLE_SETTINGS,
  DatabaseIdentityEnrollmentError,
  defineDatabaseIdentityEnrollment,
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from './database-identity-manifest.ts';
export type {
  DatabaseAcceptedFinding,
  DatabaseIdentity,
  DatabaseIdentityEnrollment,
  DatabaseOwnerIdentityDescriptor,
  DatabaseRoleGrants,
  DatabaseScopeAuthority,
  DatabaseTableGrant,
  DatabaseTablePrivilege,
} from './database-identity-manifest.ts';

/** Application composition supplies this service; Core never discovers owners from ambient state. */
export class DatabaseIdentityEnrollmentContext extends Context.Service<
  DatabaseIdentityEnrollmentContext,
  DatabaseIdentityEnrollment
>()('@app/core-runtime/db/database-identities/DatabaseIdentityEnrollmentContext') {}

export const makeDatabaseIdentityEnrollmentLive = (enrollment: DatabaseIdentityEnrollment) =>
  Layer.succeed(DatabaseIdentityEnrollmentContext, enrollment);

export const databaseIdentityForRole = (enrollment: DatabaseIdentityEnrollment, role: string) =>
  Option.fromUndefinedOr(enrollment.identities.find((identity) => identity.role === role));

export const gatewayScopeGrantRoleForAudience = (
  enrollment: DatabaseIdentityEnrollment,
  audience: string,
): Option.Option<string> =>
  Option.fromUndefinedOr(
    enrollment.identities.find(
      (identity) => identity.scopeAuthority === 'gateway_grant' && identity.gatewayScopeAudiences.includes(audience),
    )?.role,
  );
