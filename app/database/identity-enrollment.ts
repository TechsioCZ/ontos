import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';
import { PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR } from '@app/party-registry-identity-contracts';

/** Explicit application composition for administrative and development tooling. */
export const APP_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([
  PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR,
]);

export const DATABASE_IDENTITIES = APP_DATABASE_IDENTITY_ENROLLMENT.identities;
export const TRUST_ROUTINES = APP_DATABASE_IDENTITY_ENROLLMENT.trustRoutines;
