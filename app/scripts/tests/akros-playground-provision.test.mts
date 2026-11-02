import { v1 } from '@authzed/authzed-node';
import { expect, it } from 'effect-rstest';

import {
  akrosPlaygroundAccounts,
  akrosPlaygroundDefinition,
  akrosPlaygroundRelationships,
  akrosPlaygroundServices,
  akrosPlaygroundTenantId,
} from '../demo/akros-playground-policy.mts';
import { akrosProvisionFingerprint } from '../demo/akros-playground-provision.mts';
import { demoTenantId } from '../demo/fixture-ids.mts';
import { companyHumanAccounts, demoHumanAccounts, eshopDemoRoles } from '../demo/permissions.mts';

const actions = [
  {
    actionKey: 'demo.merchandise.apply-command',
    legalEntityScope: 'required',
    owningModuleKey: 'demo.merchandise',
    provisioning: 'explicit',
  },
] as const;

it('creates independent AKROS identities without changing the demo role definitions', () => {
  expect(akrosPlaygroundTenantId).not.toBe(demoTenantId);
  expect(akrosPlaygroundAccounts.map(({ email }) => email)).toEqual([
    'admin@akros.playground',
    'eshop@akros.playground',
    'expedice@akros.playground',
  ]);
  expect(akrosPlaygroundAccounts[1].role).toBe(eshopDemoRoles.akrosAdmin);
  expect(akrosPlaygroundAccounts[2].role).toBe(eshopDemoRoles.fulfilment);
  const demoIds = new Set([...demoHumanAccounts, ...companyHumanAccounts].map(({ principalId }) => principalId));
  expect(
    [...akrosPlaygroundAccounts, ...akrosPlaygroundServices].some(({ principalId }) => demoIds.has(principalId)),
  ).toBe(false);
});

it('grants no demo principal a relationship in the new tenant', () => {
  const rows = akrosPlaygroundRelationships(actions);
  const serialized = rows.map((row) => v1.Relationship.toJsonString(row)).join('\n');
  expect(serialized).not.toContain(demoTenantId);
  for (const { principalId } of [...demoHumanAccounts, ...companyHumanAccounts]) {
    expect(serialized).not.toContain(principalId);
  }
  expect(new Set(rows.map((row) => v1.Relationship.toJsonString(row))).size).toBe(rows.length);
  expect(rows.filter((row) => row.relation === 'superadmin')).toHaveLength(1);
});

it('keeps company membership admission explicit and never stores account passwords in a plan definition', () => {
  const rows = akrosPlaygroundRelationships(actions);
  for (const { principalId } of akrosPlaygroundAccounts) {
    expect(
      rows.some(
        (row) =>
          row.resource?.objectType === 'tenant' &&
          row.relation === 'member' &&
          row.subject?.object?.objectId === principalId,
      ),
    ).toBe(false);
    expect(
      rows.some(
        (row) =>
          row.resource?.objectType === 'tenant' &&
          row.relation === 'company_member' &&
          row.subject?.object?.objectId === principalId,
      ),
    ).toBe(true);
  }
  expect(JSON.stringify(akrosPlaygroundDefinition)).not.toContain('password');
  expect(akrosProvisionFingerprint('reviewed')).not.toBe(akrosProvisionFingerprint('changed'));
});
