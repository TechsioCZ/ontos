import type { v1 } from '@authzed/authzed-node';
import { expect, it } from 'effect-rstest';

import { coreActionCatalog } from '../../packages/core-runtime/src/modules/actions/catalog.ts';
import {
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '../../packages/core-runtime/src/permissions/context-access.ts';
import {
  akrosPlaygroundLegalEntityId,
  akrosPlaygroundRelationships,
  akrosPlaygroundTenantId,
} from '../demo/akros-playground-policy.mts';
import { principalRelationships } from '../demo/permissions.mts';

const tenantId = '70000000-0000-4000-8000-0000000000c1';
const legalEntityId = '71000000-0000-4000-8000-0000000000c1';
const principalId = '72000000-0000-4000-8000-0000000000c1';
const coreModuleIds = [...new Set(coreActionCatalog.map(({ owningModuleKey }) => owningModuleKey))];
const actions = [
  {
    actionKey: 'demo.merchandise.apply-command',
    legalEntityScope: 'required',
    owningModuleKey: 'demo.merchandise',
    provisioning: 'explicit',
  },
] as const;

it('gives every company administrator grant the Core module edge for each Core module', () => {
  const rows = principalRelationships(
    principalId,
    { companyRole: 'admin', label: 'Company administrator', modules: {} },
    [],
    legalEntityId,
    tenantId,
    'admin',
  );
  const legal = toLegalEntityAccessObjectId(tenantId, legalEntityId);
  for (const moduleId of coreModuleIds) {
    expect(rows).toContainEqual({
      relation: 'legal_entity',
      resourceId: toModuleAccessObjectId(tenantId, legalEntityId, moduleId),
      resourceType: 'module_access',
      subjectId: legal,
      subjectType: 'legal_entity',
    });
  }
});

it('grants no Core module edge to a role without company administration', () => {
  const rows = principalRelationships(
    principalId,
    { label: 'Catalogue manager', modules: { 'demo.merchandise': 'write' } },
    actions,
    legalEntityId,
    tenantId,
    'catalogue',
  );
  const coreEdges = rows.filter(
    ({ relation, resourceId, resourceType }) =>
      relation === 'legal_entity' &&
      resourceType === 'module_access' &&
      coreModuleIds.some((moduleId) => resourceId === toModuleAccessObjectId(tenantId, legalEntityId, moduleId)),
  );
  expect(coreEdges).toEqual([]);
});

it('connects every Core module of the AKROS company whose administrators are provisioned', () => {
  const rows: readonly v1.Relationship[] = akrosPlaygroundRelationships(actions);
  const legal = toLegalEntityAccessObjectId(akrosPlaygroundTenantId, akrosPlaygroundLegalEntityId);
  const unconnected = coreModuleIds.filter(
    (moduleId) =>
      !rows.some(
        (row) =>
          row.resource?.objectType === 'module_access' &&
          row.resource.objectId ===
            toModuleAccessObjectId(akrosPlaygroundTenantId, akrosPlaygroundLegalEntityId, moduleId) &&
          row.relation === 'legal_entity' &&
          row.subject?.object?.objectId === legal,
      ),
  );
  expect(unconnected).toEqual([]);
});
