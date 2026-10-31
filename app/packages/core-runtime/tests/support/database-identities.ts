import { defineDatabaseIdentityEnrollment } from '../../src/db/database-identity-manifest.ts';
import type { DatabaseOwnerIdentityDescriptor } from '../../src/db/database-identity-manifest.ts';
import type { DatabaseConfigValue, DatabaseIdentityConnections } from '../../src/db/config.ts';

/**
 * Test-owned enrollment. Native database suites retain the provisioned catalog's exact values;
 * Core tests do not discover an owner or import its private implementation.
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
export const FIXTURE_REQUEST_IDENTITY = FIXTURE_DESCRIPTOR.request;
export const FIXTURE_WORKER_IDENTITY = FIXTURE_DESCRIPTOR.worker;

/** A missing enrolled connection is a broken fixture, never a reason to use the shared login. */
export const testDatabaseIdentityConnection = (
  connections: DatabaseIdentityConnections,
  identityId: string,
): DatabaseConfigValue => {
  const connection = connections.runtime[identityId];
  if (connection === undefined) {
    throw new Error(`The test database enrollment has no connection for ${identityId}`);
  }
  return connection;
};
