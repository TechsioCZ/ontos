import { defineDatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';
import type { DatabaseOwnerIdentityDescriptor } from '@app/core-runtime/db/database-identity-manifest';

/**
 * Test-owned enrollment. Native database suites retain the provisioned catalog's exact values;
 * The fixture does not discover an owner or import its private implementation.
 */
const FIXTURE_MODULE_KEY = 'party.registry';
export const FIXTURE_DESCRIPTOR = {
  moduleKey: FIXTURE_MODULE_KEY,
  policyPrefix: 'party_registry',
  request: {
    cloudflareHyperdrive: {
      binding: 'PARTY_REGISTRY_HYPERDRIVE',
      idVariable: 'ULTRAMODERN_CLOUDFLARE_PARTY_REGISTRY_HYPERDRIVE_ID',
    },
    gatewayScopeAudiences: ['party-registry'],
    handlesBearerAssertions: true,
    id: 'party_registry_request',
    ownerModuleKey: FIXTURE_MODULE_KEY,
    registersGatewayScopeGrants: false,
    role: 'party_registry_runtime',
    scopeAuthority: 'gateway_grant',
    urlKey: 'PARTY_REGISTRY_DATABASE_URL',
  },
  schemas: ['party', 'contacts'],
  worker: {
    cloudflareHyperdrive: null,
    gatewayScopeAudiences: [],
    handlesBearerAssertions: false,
    id: 'party_registry_worker',
    ownerModuleKey: FIXTURE_MODULE_KEY,
    registersGatewayScopeGrants: false,
    role: 'party_registry_worker',
    scopeAuthority: 'session_setting',
    urlKey: 'PARTY_REGISTRY_WORKER_DATABASE_URL',
  },
} as const satisfies DatabaseOwnerIdentityDescriptor;

export const FIXTURE_DATABASE_IDENTITY_ENROLLMENT = defineDatabaseIdentityEnrollment([FIXTURE_DESCRIPTOR]);
export const DATABASE_IDENTITIES = FIXTURE_DATABASE_IDENTITY_ENROLLMENT.identities;
