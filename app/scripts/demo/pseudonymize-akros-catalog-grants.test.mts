import { toLegalEntityAccessObjectId } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';

import { akrosPlaygroundLegalEntityId, akrosPlaygroundTenantId } from './akros-playground-policy.mts';
import {
  akrosDemoLegalEntityId,
  crmDemoLegalEntityId,
  demoLegalEntityId,
  demoTenantId,
  eshopDemoLegalEntityId,
  rentalDemoLegalEntityId,
} from './fixture-ids.mts';
import { toSpiceDbActionObjectId } from '../../packages/core-runtime/src/permissions/service.ts';
import { demoHumanAccounts } from './permissions.mts';
import {
  catalogOperatorAction,
  catalogOperatorGrants,
  catalogOperatorPrincipalId,
  catalogOperatorProbes,
  catalogOperatorRelationships,
} from './pseudonymize-akros-catalog-grants.mts';

const action = (actionKey: string) =>
  ({ actionKey, legalEntityScope: 'required', owningModuleKey: 'demo.merchandise', provisioning: 'explicit' }) as const;
const actionId = (actionKey: string) =>
  toSpiceDbActionObjectId({ actionKey, legalEntityId: akrosDemoLegalEntityId, tenantId: demoTenantId });
const actions = [
  action(catalogOperatorAction),
  action('demo.merchandise.bootstrap-playground-catalog'),
  action('demo.merchandise.request-search-rebuild'),
];

it('grants only the tenant superadmin, only in the demo company, only the catalog Action', () => {
  expect(catalogOperatorPrincipalId).toBe(demoHumanAccounts[0].principalId);
  const rows = catalogOperatorRelationships(actions);
  const exactlyApplyCommand = catalogOperatorRelationships([action(catalogOperatorAction)]);
  // Other merchandise Actions add nothing: the role carries the apply-command grant alone.
  expect(rows).toEqual(exactlyApplyCommand);
  const encoded = JSON.stringify(rows);
  expect(encoded).toContain(actionId(catalogOperatorAction));
  expect(encoded).not.toContain(actionId('demo.merchandise.bootstrap-playground-catalog'));
  expect(encoded).not.toContain(actionId('demo.merchandise.request-search-rebuild'));
  expect(rows.some(({ relation, resourceType }) => relation === 'member' && resourceType === 'legal_entity')).toBe(
    false,
  );
  expect(rows.some(({ relation, resourceType }) => relation === 'member' && resourceType === 'tenant')).toBe(false);
  expect(catalogOperatorGrants(actions)).toHaveLength(new Set(rows.map((row) => JSON.stringify(row))).size);
});

it('writes nothing for another company or the AKROS playground tenant', () => {
  const encoded = JSON.stringify(catalogOperatorRelationships(actions));
  for (const legalEntityId of [
    demoLegalEntityId,
    rentalDemoLegalEntityId,
    crmDemoLegalEntityId,
    eshopDemoLegalEntityId,
  ]) {
    expect(encoded).not.toContain(toLegalEntityAccessObjectId(demoTenantId, legalEntityId) ?? legalEntityId);
  }
  expect(encoded).not.toContain(akrosPlaygroundTenantId);
  expect(encoded).not.toContain(
    toLegalEntityAccessObjectId(akrosPlaygroundTenantId, akrosPlaygroundLegalEntityId) ?? '',
  );
  expect(encoded).toContain(
    toLegalEntityAccessObjectId(demoTenantId, akrosDemoLegalEntityId) ?? akrosDemoLegalEntityId,
  );
});

it('verify proves the grant, an unchanged rest of the tenant and a closed AKROS playground', () => {
  const probes = catalogOperatorProbes();
  const rules = (rule: string) => probes.filter((probe) => probe.rule === rule).map(({ label }) => label);
  expect(rules('granted')).toEqual([
    'ŠroubShop: demo.merchandise.read_all',
    'ŠroubShop: demo.merchandise.write_all',
    `ŠroubShop: execute ${catalogOperatorAction}`,
    'ŠroubShop: open merchandise',
  ]);
  expect(rules('unchanged')).toContain('ŠroubShop: execute demo.merchandise.bootstrap-playground-catalog');
  expect(rules('unchanged').filter((label) => label.startsWith('Kavárna Doma'))).toHaveLength(4);
  expect(rules('denied')).toContain('AKROS playground: tenant access');
  expect(rules('denied').filter((label) => label.startsWith('AKROS playground: '))).toHaveLength(5);
  expect(new Set(probes.map(({ label }) => label)).size).toBe(probes.length);
});
