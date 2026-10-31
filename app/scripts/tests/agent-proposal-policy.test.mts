import { expect, it } from 'effect-rstest';

import { toContextPermissionAccessObjectId } from '../../packages/core-runtime/src/permissions/context-access.ts';
import { toScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import { toSpiceDbActionGrantObjectId } from '../../packages/core-runtime/src/permissions/service.ts';
import { demoLegalEntityId, demoTenantId, rentalDemoLegalEntityId } from '../demo/fixture-ids.mts';
import {
  agentBotPrincipal,
  demoHumanAccounts,
  demoPermissionRelationships,
  principalRelationships,
  siamparkRentalPersonas,
  storefrontPrincipal,
} from '../demo/permissions.mts';
import type { DemoAction, DemoPermissionInstallation, DemoRelationship } from '../demo/permissions.mts';

const principalId = 'operator-a';
const lifecycleKey = 'core.identity.mutate-agent-proposals';
const taskKey = 'work.tasks.apply-command';
const taskModule = 'work.tasks';
const billingKey = 'finance.billing.apply-command';
const merchandiseKey = 'demo.merchandise.apply-command';
const descriptor = (actionKey: string, owningModuleKey: string): DemoAction => ({
  actionKey,
  legalEntityScope: 'required',
  owningModuleKey,
  provisioning: 'explicit',
});
const lifecycle = descriptor(lifecycleKey, 'core.identity');
const actions = [
  lifecycle,
  descriptor('core.identity.configure-agent', 'core.identity'),
  descriptor(taskKey, taskModule),
  descriptor(billingKey, 'finance.billing'),
  descriptor(merchandiseKey, 'demo.merchandise'),
];
const publishedModuleKeys = [taskModule, 'finance.billing', 'demo.merchandise'];
const installation: DemoPermissionInstallation = {
  companies: [demoLegalEntityId, rentalDemoLegalEntityId].map((legalEntityId) => ({
    legalEntityId,
    status: 'active',
    tenantId: demoTenantId,
  })),
  moduleStates: publishedModuleKeys.map((moduleKey) => ({ moduleKey, state: 'active', tenantId: demoTenantId })),
  publishedModuleKeys,
};
const grantsFor = (rows: readonly DemoRelationship[], targetPrincipalId: string) => {
  const roles = new Set(
    rows
      .filter(
        (row) =>
          row.resourceType === 'scoped_role' &&
          row.relation === 'member' &&
          row.subjectType === 'principal' &&
          row.subjectId === targetPrincipalId,
      )
      .map((row) => row.resourceId),
  );
  return rows.filter(
    (row) =>
      row.resourceType === 'action_grant' &&
      row.relation === 'role' &&
      row.subjectType === 'scoped_role' &&
      row.subjectRelation === 'member' &&
      roles.has(row.subjectId),
  );
};
const hasGrant = (
  rows: readonly DemoRelationship[],
  targetPrincipalId: string,
  actionKey: string,
  legalEntityId: string = demoLegalEntityId,
) =>
  grantsFor(rows, targetPrincipalId).some(
    (row) => row.resourceId === toSpiceDbActionGrantObjectId({ actionKey, legalEntityId, tenantId: demoTenantId }),
  );

it('provisions human lifecycle execution explicitly while retaining each actual operator business grant boundary', () => {
  const rows = demoPermissionRelationships(actions, installation);
  const [, sales, accounting, warehouse] = demoHumanAccounts;
  for (const human of demoHumanAccounts) {
    expect(hasGrant(rows, human.principalId, lifecycleKey)).toBe(true);
    expect(hasGrant(rows, human.principalId, 'core.identity.configure-agent')).toBe(false);
  }
  expect(hasGrant(rows, sales.principalId, taskKey)).toBe(true);
  expect(hasGrant(rows, sales.principalId, billingKey)).toBe(false);
  expect(hasGrant(rows, accounting.principalId, billingKey)).toBe(true);
  expect(hasGrant(rows, accounting.principalId, taskKey)).toBe(false);
  expect(hasGrant(rows, warehouse.principalId, merchandiseKey)).toBe(true);
  expect(hasGrant(rows, warehouse.principalId, billingKey)).toBe(false);
  expect(hasGrant(rows, warehouse.principalId, lifecycleKey, rentalDemoLegalEntityId)).toBe(false);
  expect(hasGrant(rows, siamparkRentalPersonas[1].principalId, lifecycleKey, rentalDemoLegalEntityId)).toBe(true);
  expect(hasGrant(rows, siamparkRentalPersonas[3].principalId, lifecycleKey, rentalDemoLegalEntityId)).toBe(false);
  for (const principal of [agentBotPrincipal, storefrontPrincipal]) {
    expect(grantsFor(rows, principal.principalId).length).toBeGreaterThan(0);
    expect(
      grantsFor(rows, principal.principalId).some(
        (row) =>
          row.resourceId ===
          toSpiceDbActionGrantObjectId({
            actionKey: lifecycleKey,
            legalEntityId: demoLegalEntityId,
            tenantId: demoTenantId,
          }),
      ),
    ).toBe(false);
  }
});

it('uses the existing exact company role, never a tenant, foreign company or direct principal executor', () => {
  const roleKey = 'operations';
  const rows = principalRelationships(
    principalId,
    {
      label: 'Operator',
      modules: { 'work.tasks': 'write' },
      proposalReview: true,
    },
    actions,
    demoLegalEntityId,
    demoTenantId,
    roleKey,
  );
  const grants = grantsFor(rows, principalId);
  expect(new Set(grants.map((row) => row.resourceId))).toEqual(
    new Set(
      [taskKey, lifecycleKey].map((actionKey) =>
        toSpiceDbActionGrantObjectId({ actionKey, legalEntityId: demoLegalEntityId, tenantId: demoTenantId }),
      ),
    ),
  );
  expect(
    grants.every(
      (row) =>
        row.subjectId === toScopedRoleObjectId({ legalEntityId: demoLegalEntityId, roleKey, tenantId: demoTenantId }),
    ),
  ).toBe(true);
  expect(
    grants.some(
      (row) => row.resourceId === toSpiceDbActionGrantObjectId({ actionKey: lifecycleKey, tenantId: demoTenantId }),
    ),
  ).toBe(false);
  const foreign = principalRelationships(
    principalId,
    { label: 'Operator', modules: { 'work.tasks': 'write' }, proposalReview: true },
    actions,
    rentalDemoLegalEntityId,
    'foreign-tenant',
    roleKey,
  );
  expect(
    grantsFor(foreign, principalId).some((row) => grants.some((grant) => grant.resourceId === row.resourceId)),
  ).toBe(false);
  expect(rows.some((row) => row.relation === 'executor')).toBe(false);
});

it('does not infer lifecycle review authority from a role name, label or business write access', () => {
  const rows = principalRelationships(
    principalId,
    {
      label: 'Administrator',
      modules: { 'work.tasks': 'write' },
    },
    actions,
    demoLegalEntityId,
    demoTenantId,
    'superadmin',
  );
  expect(hasGrant(rows, principalId, taskKey)).toBe(true);
  expect(hasGrant(rows, principalId, lifecycleKey)).toBe(false);
});

it('lifecycle review policy does not confer missing business execution or named write permissions', () => {
  const rows = principalRelationships(
    principalId,
    {
      label: 'Reviewer',
      modules: { 'work.tasks': 'read' },
      proposalReview: true,
    },
    actions,
  );
  expect(hasGrant(rows, principalId, lifecycleKey)).toBe(true);
  expect(hasGrant(rows, principalId, taskKey)).toBe(false);
  expect(grantsFor(rows, principalId)).toHaveLength(1);
  expect(rows.some((row) => row.relation === 'writer_role')).toBe(false);
  const writePermissionId = toContextPermissionAccessObjectId(demoTenantId, demoLegalEntityId, {
    moduleId: taskModule,
    permission: 'work.tasks.write_all',
  });
  expect(
    rows.some(
      (row) =>
        row.resourceType === 'context_permission' &&
        row.resourceId === writePermissionId &&
        row.relation === 'role_grantee',
    ),
  ).toBe(false);
});

it('requires the current exact explicit Core descriptor, never a similarly named or wrongly scoped Action', () => {
  for (const descriptors of [
    [],
    [{ ...lifecycle, actionKey: `${lifecycleKey}-other` }],
    [{ ...lifecycle, owningModuleKey: taskModule }],
    [{ ...lifecycle, legalEntityScope: 'forbidden' as const }],
    [{ ...lifecycle, legalEntityScope: 'optional' as const }],
  ]) {
    const rows = principalRelationships(
      principalId,
      { label: 'Reviewer', modules: { 'work.tasks': 'write' }, proposalReview: true },
      descriptors,
    );
    expect(grantsFor(rows, principalId)).toEqual([]);
  }
});
