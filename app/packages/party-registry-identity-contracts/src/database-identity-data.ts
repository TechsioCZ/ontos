import type { DatabaseOwnerIdentityDescriptor } from '@app/core-runtime/db/database-identity-manifest';

const PARTY_MODULE = 'party.registry';

/** Party-owned identity facts, without private schema or runtime dependencies. */
export const PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR = Object.freeze({
  moduleKey: PARTY_MODULE,
  policyPrefix: 'party_registry',
  request: Object.freeze({
    cloudflareHyperdrive: Object.freeze({
      binding: 'PARTY_REGISTRY_HYPERDRIVE',
      idVariable: 'ULTRAMODERN_CLOUDFLARE_PARTY_REGISTRY_HYPERDRIVE_ID',
    }),
    gatewayScopeAudiences: Object.freeze(['party-registry']),
    handlesBearerAssertions: true,
    id: 'party_registry_request',
    ownerModuleKey: PARTY_MODULE,
    registersGatewayScopeGrants: false,
    role: 'party_registry_runtime',
    scopeAuthority: 'gateway_grant',
    urlKey: 'PARTY_REGISTRY_DATABASE_URL',
  }),
  schemas: Object.freeze(['party', 'contacts']),
  worker: Object.freeze({
    cloudflareHyperdrive: null,
    gatewayScopeAudiences: Object.freeze([]),
    handlesBearerAssertions: false,
    id: 'party_registry_worker',
    ownerModuleKey: PARTY_MODULE,
    registersGatewayScopeGrants: false,
    role: 'party_registry_worker',
    scopeAuthority: 'session_setting',
    urlKey: 'PARTY_REGISTRY_WORKER_DATABASE_URL',
  }),
} satisfies DatabaseOwnerIdentityDescriptor);

export const PARTY_REGISTRY_REQUEST_IDENTITY = PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR.request;
export const PARTY_REGISTRY_WORKER_IDENTITY = PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR.worker;
