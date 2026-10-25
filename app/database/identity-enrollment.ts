import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';
import { PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR } from '@app/party-registry/database-identities';

/** Explicit application composition for administrative and development tooling. */
export const APP_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([
  PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR,
]);

export const DATABASE_IDENTITIES = APP_DATABASE_IDENTITY_ENROLLMENT.identities;
export const DEDICATED_IDENTITY_MODULE_KEYS = APP_DATABASE_IDENTITY_ENROLLMENT.dedicatedModuleKeys;
export const TRUST_ROUTINES = APP_DATABASE_IDENTITY_ENROLLMENT.trustRoutines;

export {
  PARTY_REGISTRY_REQUEST_IDENTITY,
  PARTY_REGISTRY_WORKER_IDENTITY,
} from '@app/party-registry/database-identities';
