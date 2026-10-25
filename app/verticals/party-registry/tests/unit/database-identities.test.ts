import {
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from '@app/core-runtime/db/database-identity-manifest';
import { expect, it } from 'effect-rstest';

import {
  PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR,
  PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  PARTY_REGISTRY_WORKER_IDENTITY,
} from '../../shared/database-identities.ts';
import {
  PARTY_REGISTRY_REQUEST_DATABASE_GRANTS,
  PARTY_REGISTRY_WORKER_DATABASE_GRANTS,
  PRUNE_EXPIRED_GATEWAY_ASSERTION_REDEMPTIONS_SIGNATURE,
} from '../../src/db/database-grants.ts';

it('publishes the complete Party identity contract without changing its roles or authority', () => {
  expect(PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR).toEqual({
    moduleKey: 'party.registry',
    policyPrefix: 'party_registry',
    request: {
      cloudflareHyperdrive: {
        binding: 'PARTY_REGISTRY_HYPERDRIVE',
        idVariable: 'ULTRAMODERN_CLOUDFLARE_PARTY_REGISTRY_HYPERDRIVE_ID',
      },
      gatewayScopeAudiences: ['party-registry'],
      handlesBearerAssertions: true,
      id: 'party_registry_request',
      ownerModuleKey: 'party.registry',
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
      ownerModuleKey: 'party.registry',
      registersGatewayScopeGrants: false,
      role: 'party_registry_worker',
      scopeAuthority: 'session_setting',
      urlKey: 'PARTY_REGISTRY_WORKER_DATABASE_URL',
    },
  });
  expect(PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT.owners).toEqual([PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR]);
  expect(PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT.dedicatedModuleKeys).toEqual(['party.registry']);
  expect(PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT.identities).toEqual([
    SHARED_RUNTIME_IDENTITY,
    SHELL_GATEWAY_ISSUER_IDENTITY,
    PARTY_REGISTRY_REQUEST_IDENTITY,
    PARTY_REGISTRY_WORKER_IDENTITY,
  ]);
});

it('freezes the public owner descriptor and every nested identity fact', () => {
  for (const value of [
    PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR,
    PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR.schemas,
    PARTY_REGISTRY_REQUEST_IDENTITY,
    PARTY_REGISTRY_REQUEST_IDENTITY.cloudflareHyperdrive,
    PARTY_REGISTRY_REQUEST_IDENTITY.gatewayScopeAudiences,
    PARTY_REGISTRY_WORKER_IDENTITY,
    PARTY_REGISTRY_WORKER_IDENTITY.gatewayScopeAudiences,
  ]) {
    expect(Object.isFrozen(value)).toBe(true);
  }
});

it('grants only request-scope trust routines and grants none to the worker', () => {
  expect(PARTY_REGISTRY_REQUEST_DATABASE_GRANTS.routines).toEqual([
    'trust.establish_gateway_scope(text)',
    'trust.current_tenant_id()',
    'trust.current_legal_entity_id()',
    'trust.auth_binding_issuing_legal_entity(uuid,uuid)',
    PRUNE_EXPIRED_GATEWAY_ASSERTION_REDEMPTIONS_SIGNATURE,
  ]);
  expect(PARTY_REGISTRY_WORKER_DATABASE_GRANTS.routines).toEqual([]);
});
