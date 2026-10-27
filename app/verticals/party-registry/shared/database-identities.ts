import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';
import type { DatabaseOwnerIdentityDescriptor } from '@app/core-runtime/db/database-identity-manifest';

const PARTY_REGISTRY_MODULE_ID = 'party.registry' as const;

/** Party-owned identity facts, without private schema or runtime dependencies. */
export const PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR = Object.freeze({
  moduleKey: PARTY_REGISTRY_MODULE_ID,
  policyPrefix: 'party_registry',
  schemas: Object.freeze(['party', 'contacts']),
  request: Object.freeze({
    cloudflareHyperdrive: Object.freeze({
      binding: 'PARTY_REGISTRY_HYPERDRIVE',
      idVariable: 'ULTRAMODERN_CLOUDFLARE_PARTY_REGISTRY_HYPERDRIVE_ID',
    }),
    gatewayScopeAudiences: Object.freeze(['party-registry']),
    handlesBearerAssertions: true,
    id: 'party_registry_request',
    ownerModuleKey: PARTY_REGISTRY_MODULE_ID,
    registersGatewayScopeGrants: false,
    role: 'party_registry_runtime',
    scopeAuthority: 'gateway_grant',
    urlKey: 'PARTY_REGISTRY_DATABASE_URL',
  }),
  worker: Object.freeze({
    cloudflareHyperdrive: null,
    gatewayScopeAudiences: Object.freeze([]),
    handlesBearerAssertions: false,
    id: 'party_registry_worker',
    ownerModuleKey: PARTY_REGISTRY_MODULE_ID,
    registersGatewayScopeGrants: false,
    role: 'party_registry_worker',
    scopeAuthority: 'session_setting',
    urlKey: 'PARTY_REGISTRY_WORKER_DATABASE_URL',
  }),
} satisfies DatabaseOwnerIdentityDescriptor);

export const PARTY_REGISTRY_REQUEST_IDENTITY = PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR.request;
export const PARTY_REGISTRY_WORKER_IDENTITY = PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR.worker;

/** The independently deployed Party API and worker enroll only their owner descriptor. */
export const PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([
  PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR,
]);
