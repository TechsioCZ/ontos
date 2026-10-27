import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';
import { PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR } from './database-identity-data.ts';

export {
  PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  PARTY_REGISTRY_WORKER_IDENTITY,
} from './database-identity-data.ts';

/** The independently deployed Party API and worker enroll only their owner descriptor. */
export const PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([
  PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR,
]);
