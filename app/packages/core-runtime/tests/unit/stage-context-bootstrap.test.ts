import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  STAGE_CONTEXTS,
  STAGE_CONTEXT_ORDER,
  STAGE_RETIRED_CONTEXTS,
  STAGE_TENANT_ROLE_RELATIONS,
  buildRetiredStageContextRelationships,
  buildStageContextRelationships,
} from '../../src/install/stage-context-bootstrap.ts';

const techsio = {
  defaultLocale: 'cs',
  legalEntityId: '71000000-0000-4000-8000-000000000001',
  legalName: 'TechsioCZ',
  moduleId: 'party.registry',
  moduleStateId: '74000000-0000-4000-8000-000000000001',
  registrationCountry: 'CZ',
  registrationNumber: 'DEMO-TECHSIOCZ',
  tenantId: '70000000-0000-4000-8000-000000000001',
  tenantName: 'Techsio',
  tenantSlug: 'techsio',
} as const;

const akros = {
  defaultLocale: 'cs',
  legalEntityId: '71000000-0000-4000-8000-000000000003',
  legalName: 'Akros',
  moduleId: 'party.registry',
  moduleStateId: '74000000-0000-4000-8000-000000000003',
  registrationCountry: 'CZ',
  registrationNumber: 'DEMO-AKROS',
  tenantId: '70000000-0000-4000-8000-000000000003',
  tenantName: 'Akros',
  tenantSlug: 'akros',
} as const;

it('defines one demo and one admin account for each of the Techsio and Akros stage Tenants', () => {
  expect(STAGE_CONTEXTS).toEqual({
    akrosAdmin: {
      ...akros,
      authBindingId: '73000000-0000-4000-8000-000000000013',
      principalDisplayName: 'Akros Admin',
      principalId: '72000000-0000-4000-8000-000000000013',
      role: 'admin',
    },
    akrosDemo: {
      ...akros,
      authBindingId: '73000000-0000-4000-8000-000000000003',
      principalDisplayName: 'Akros Demo',
      principalId: '72000000-0000-4000-8000-000000000003',
      role: 'demo',
    },
    techsioAdmin: {
      ...techsio,
      authBindingId: '73000000-0000-4000-8000-000000000011',
      principalDisplayName: 'Techsio Admin',
      principalId: '72000000-0000-4000-8000-000000000011',
      role: 'admin',
    },
    techsioDemo: {
      ...techsio,
      authBindingId: '73000000-0000-4000-8000-000000000001',
      principalDisplayName: 'Techsio Demo',
      principalId: '72000000-0000-4000-8000-000000000001',
      role: 'demo',
    },
  });
  expect(STAGE_CONTEXT_ORDER).toEqual(['techsioDemo', 'techsioAdmin', 'akrosDemo', 'akrosAdmin']);
});

it.effect('grants Tenant roles by account role, never support, and only inside the own Tenant', () =>
  Effect.gen(function* grantsTenantRolesByAccountRole() {
    for (const key of STAGE_CONTEXT_ORDER) {
      const context = STAGE_CONTEXTS[key];
      const relationships = yield* buildStageContextRelationships(context);
      const tenantRoles = relationships
        .filter(({ relation, resourceType }) => resourceType === 'tenant' && relation !== 'member')
        .map(({ relation }) => relation);
      expect(tenantRoles).toEqual([...STAGE_TENANT_ROLE_RELATIONS[context.role]]);
      expect(tenantRoles).not.toContain('support');
      expect(
        relationships
          .filter(({ resourceType }) => resourceType === 'tenant')
          .every(({ resourceId }) => resourceId === context.tenantId),
      ).toBe(true);
    }
    expect(STAGE_TENANT_ROLE_RELATIONS.demo).toEqual(['party_identity_reader']);
    expect(STAGE_TENANT_ROLE_RELATIONS.admin).toContain('identity_admin');
  }),
);

it.effect('retires the former Siam Park context through exact relationship deletion', () =>
  Effect.gen(function* retiresSiamPark() {
    expect(Object.keys(STAGE_RETIRED_CONTEXTS)).toEqual(['siampark']);
    const relationships = yield* buildRetiredStageContextRelationships(STAGE_RETIRED_CONTEXTS.siampark);
    expect(relationships).toHaveLength(5);
    expect(relationships[0]).toEqual({
      relation: 'member',
      resourceId: '70000000-0000-4000-8000-000000000002',
      resourceType: 'tenant',
      subjectId: '72000000-0000-4000-8000-000000000002',
      subjectType: 'principal',
    });
    const retiredTenantId: string = STAGE_RETIRED_CONTEXTS.siampark.tenantId;
    expect(Object.values(STAGE_CONTEXTS).map(({ tenantId }) => tenantId)).not.toContain(retiredTenantId);
  }),
);
