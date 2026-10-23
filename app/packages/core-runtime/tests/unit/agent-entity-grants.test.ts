import type { v1 } from '@authzed/authzed-node';
import { expect, it } from 'effect-rstest';

import {
  agentGrantRelationships,
  agentModuleAccessOf,
  isReadPermission,
} from '../../src/install/agent-entity-grants.ts';
import type { AgentScopedRolePolicyInput } from '../../src/install/agent-entity-grants.ts';
import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '../../src/permissions/context-access.ts';
import { agentScopedRoleObjectId } from '../../src/permissions/scoped-role.ts';
import { toSpiceDbActionGrantObjectId } from '../../src/permissions/service.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const legalEntityId = '71000000-0000-4000-8000-000000000020';
const otherCompany = '71000000-0000-4000-8000-000000000021';
const principalId = '72000000-0000-4000-8000-000000000020';
const scope = { legalEntityId, principalId, tenantId };
const moduleAccess = (company: string, moduleId: string) => ({
  relation: 'accessor',
  resourceId: toModuleAccessObjectId(tenantId, company, moduleId) ?? '',
  resourceType: 'module_access',
});
const permission = (moduleId: string, value: string) => ({
  relation: 'grantee',
  resourceId: toContextPermissionAccessObjectId(tenantId, legalEntityId, { moduleId, permission: value }) ?? '',
  resourceType: 'context_permission',
});
const template = [
  { relation: 'member', resourceId: tenantId, resourceType: 'tenant' },
  { relation: 'identity_admin', resourceId: tenantId, resourceType: 'tenant' },
  { relation: 'party_identity_reader', resourceId: tenantId, resourceType: 'tenant' },
  {
    relation: 'member',
    resourceId: toLegalEntityAccessObjectId(tenantId, legalEntityId) ?? '',
    resourceType: 'legal_entity',
  },
  {
    relation: 'counterparty_manager',
    resourceId: toLegalEntityAccessObjectId(tenantId, legalEntityId) ?? '',
    resourceType: 'legal_entity',
  },
  moduleAccess(legalEntityId, 'core.shell'),
  moduleAccess(legalEntityId, 'demo.crm'),
  moduleAccess(legalEntityId, 'work.tasks'),
  moduleAccess(legalEntityId, 'example.counterparties'),
  moduleAccess(otherCompany, 'demo.crm'),
  permission('demo.crm', 'demo_crm.read_all'),
  permission('demo.crm', 'demo_crm.write_all'),
  permission('demo.crm', 'demo.crm.assign'),
  permission('work.tasks', 'work_tasks.read_all'),
  permission('work.tasks', 'work_tasks.write_all'),
];
const input: AgentScopedRolePolicyInput = {
  ...scope,
  actions: [
    // Deliberately unrelated key prefixes: only the composition's owner decides module authority.
    { actionKey: 'unrelated.command', legalEntityScope: 'required', owningModuleKey: 'demo.crm' },
    { actionKey: 'demo.crm.not-owned-by-crm', legalEntityScope: 'required', owningModuleKey: 'work.tasks' },
    {
      actionKey: 'example.create-counterparty',
      legalEntityScope: 'optional',
      owningModuleKey: 'example.counterparties',
    },
    { actionKey: 'tenant.only', legalEntityScope: 'forbidden', owningModuleKey: 'demo.crm' },
  ],
  legalEntityWriteRelations: new Map([['example.counterparties', ['counterparty_manager']]]),
  modules: [
    { access: 'write', moduleId: 'demo.crm' },
    { access: 'read', moduleId: 'work.tasks' },
  ],
  template,
  writePolicy: 'direct',
};
const has = (relationships: readonly v1.Relationship[], resourceType: string, resourceId: string, relation: string) =>
  relationships.some(
    (item) =>
      item.resource?.objectType === resourceType && item.resource.objectId === resourceId && item.relation === relation,
  );
const grantId = (actionKey: string, company = legalEntityId) =>
  toSpiceDbActionGrantObjectId({ actionKey, legalEntityId: company, tenantId });

it('classifies the retained named-permission restriction and company module choices', () => {
  expect(isReadPermission('demo_crm.read_all')).toBe(true);
  expect(isReadPermission('demo.crm.assign')).toBe(false);
  expect(agentModuleAccessOf(template, legalEntityId)).toEqual([
    { access: 'write', moduleId: 'demo.crm' },
    { access: 'read', moduleId: 'example.counterparties' },
    { access: 'write', moduleId: 'work.tasks' },
  ]);
});

it('writes explicit role policy and only the agent principal membership, never executors', () => {
  const result = agentGrantRelationships(input);
  const roleId = agentScopedRoleObjectId(scope);
  expect(has(result, 'scoped_role', roleId, 'member')).toBe(true);
  const policies = result.filter((item) => item.relation !== 'member');
  expect(policies.length).toBeGreaterThan(0);
  expect(
    policies.every(
      (item) =>
        item.subject?.object?.objectType === 'scoped_role' &&
        item.subject.object.objectId === roleId &&
        item.subject.optionalRelation === 'member',
    ),
  ).toBe(true);
  expect(
    result.filter((item) => item.relation === 'member').every((item) => item.subject?.object?.objectId === principalId),
  ).toBe(true);
  expect(result.some((item) => item.resource?.objectType === 'action' || item.relation === 'executor')).toBe(false);
  expect(has(result, 'module_access', moduleAccess(legalEntityId, 'demo.crm').resourceId, 'writer_role')).toBe(true);
  expect(has(result, 'module_access', moduleAccess(legalEntityId, 'work.tasks').resourceId, 'reader_role')).toBe(true);
  expect(has(result, 'context_permission', permission('demo.crm', 'demo.crm.assign').resourceId, 'role_grantee')).toBe(
    true,
  );
  expect(has(result, 'tenant', tenantId, 'identity_admin')).toBe(false);
});

it('uses exact composition ownership and company scope rather than Action key prefixes', () => {
  const result = agentGrantRelationships(input);
  expect(has(result, 'action_grant', grantId('unrelated.command'), 'role')).toBe(true);
  expect(has(result, 'action_grant', grantId('demo.crm.not-owned-by-crm'), 'role')).toBe(false);
  expect(has(result, 'action_grant', grantId('tenant.only'), 'role')).toBe(false);
  expect(has(result, 'action_grant', grantId('unrelated.command', otherCompany), 'role')).toBe(false);
  expect(has(result, 'module_access', moduleAccess(otherCompany, 'demo.crm').resourceId, 'writer_role')).toBe(false);
});

it('keeps approval and read-only restrictions even when a write module was selected', () => {
  for (const writePolicy of ['approval', 'read_only'] as const) {
    const result = agentGrantRelationships({ ...input, writePolicy });
    expect(has(result, 'module_access', moduleAccess(legalEntityId, 'demo.crm').resourceId, 'reader_role')).toBe(true);
    expect(
      result.some(
        (item) =>
          item.relation === 'writer_role' || (item.resource?.objectType === 'action_grant' && item.relation === 'role'),
      ),
    ).toBe(false);
    expect(has(result, 'action_grant', grantId('unrelated.command'), 'proposer_role')).toBe(writePolicy === 'approval');
    expect(has(result, 'action_grant', grantId('demo.crm.not-owned-by-crm'), 'proposer_role')).toBe(false);
    expect(
      has(result, 'context_permission', permission('demo.crm', 'demo_crm.write_all').resourceId, 'role_grantee'),
    ).toBe(false);
    expect(
      has(result, 'context_permission', permission('demo.crm', 'demo_crm.read_all').resourceId, 'role_grantee'),
    ).toBe(true);
  }
});

it('grants module-declared company authority only to a selected direct writer', () => {
  const result = agentGrantRelationships({
    ...input,
    modules: [{ access: 'write', moduleId: 'example.counterparties' }],
  });
  expect(
    has(result, 'legal_entity', toLegalEntityAccessObjectId(tenantId, legalEntityId) ?? '', 'counterparty_manager'),
  ).toBe(true);
  expect(has(result, 'action_grant', grantId('example.create-counterparty'), 'role')).toBe(true);
});

it('rejects ambiguous composition ownership and duplicate or Core module selections', () => {
  expect(() =>
    agentGrantRelationships({
      ...input,
      actions: [
        ...input.actions,
        { actionKey: 'unrelated.command', legalEntityScope: 'required', owningModuleKey: 'work.tasks' },
      ],
    }),
  ).toThrow();
  expect(() =>
    agentGrantRelationships({ ...input, modules: [...input.modules, { access: 'read', moduleId: 'demo.crm' }] }),
  ).toThrow();
  expect(() =>
    agentGrantRelationships({ ...input, modules: [{ access: 'write', moduleId: 'core.identity' }] }),
  ).toThrow();
});

it('has distinct agent/company roles and emits no selected module policy for an empty selection', () => {
  expect(agentScopedRoleObjectId(scope)).not.toBe(agentScopedRoleObjectId({ ...scope, legalEntityId: otherCompany }));
  expect(agentScopedRoleObjectId(scope)).not.toBe(agentScopedRoleObjectId({ ...scope, principalId: 'another-agent' }));
  const result = agentGrantRelationships({ ...input, modules: [], template: [] });
  expect(
    result.some((item) =>
      ['module_access', 'context_permission', 'action_grant'].includes(item.resource?.objectType ?? ''),
    ),
  ).toBe(false);
});

it('preserves explicit Shell entry access without granting Shell resource reads or administration', () => {
  const result = agentGrantRelationships(input);
  const shellId = toModuleAccessObjectId(tenantId, legalEntityId, 'core.shell') ?? '';
  expect(has(result, 'module_access', shellId, 'accessor_role')).toBe(true);
  expect(has(result, 'module_access', shellId, 'reader_role')).toBe(false);
  expect(has(result, 'module_access', shellId, 'writer_role')).toBe(false);
  const noShell = agentGrantRelationships({ ...input, template: [] });
  expect(has(noShell, 'module_access', shellId, 'accessor_role')).toBe(false);
});
