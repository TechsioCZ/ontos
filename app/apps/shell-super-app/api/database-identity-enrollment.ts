import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';
import { PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR } from '@app/party-registry-identity-contracts';

/** Shell enrolls the published identity contracts needed to issue owner-scoped gateway grants. */
export const SHELL_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([
  PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR,
]);
