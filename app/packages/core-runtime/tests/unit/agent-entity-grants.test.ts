import { agentGrantRelationships, agentModuleAccessOf, isReadPermission, toContextPermissionAccessObjectId, toLegalEntityAccessObjectId, toModuleAccessObjectId } from '../../src/index.ts';
import { toSpiceDbActionObjectId } from '../../src/permissions/service.ts';
import { expect, it } from 'effect-rstest';

const tenant = '70000000-0000-4000-8000-000000000020';
const company = '71000000-0000-4000-8000-000000000020';
const other = '71000000-0000-4000-8000-000000000021';

const moduleAccess = (legalEntity: string, moduleId: string) => ({
  relation: 'accessor',
  resourceId: toModuleAccessObjectId(tenant, legalEntity, moduleId) ?? '',
  resourceType: 'module_access',
});
const permission = (moduleId: string, value: string) => ({
  relation: 'grantee',
  resourceId: toContextPermissionAccessObjectId(tenant, company, { moduleId, permission: value }) ?? '',
  resourceType: 'context_permission',
});
const executor = (actionKey: string) => ({
  relation: 'executor',
  resourceId: toSpiceDbActionObjectId(actionKey),
  resourceType: 'action',
});

const template = [
  { relation: 'member', resourceId: tenant, resourceType: 'tenant' },
  { relation: 'identity_admin', resourceId: tenant, resourceType: 'tenant' },
  { relation: 'party_identity_reader', resourceId: tenant, resourceType: 'tenant' },
  { relation: 'member', resourceId: toLegalEntityAccessObjectId(tenant, company) ?? '', resourceType: 'legal_entity' },
  {
    relation: 'counterparty_manager',
    resourceId: toLegalEntityAccessObjectId(tenant, company) ?? '',
    resourceType: 'legal_entity',
  },
  moduleAccess(company, 'core.shell'),
  moduleAccess(company, 'core.identity'),
  moduleAccess(company, 'demo.crm'),
  moduleAccess(company, 'work.tasks'),
  moduleAccess(other, 'demo.crm'),
  permission('demo.crm', 'demo_crm.read_all'),
  permission('demo.crm', 'demo_crm.write_all'),
  permission('demo.crm', 'demo.crm.assign'),
  permission('work.tasks', 'work_tasks.read_all'),
  permission('work.tasks', 'work_tasks.write_all'),
  executor('demo.crm.apply-command'),
  executor('work.tasks.apply-command'),
  executor('core.identity.manage-demo-account'),
];

const has = (
  result: readonly { readonly relation: string; readonly resourceId: string; readonly resourceType: string }[],
  relationship: { readonly relation: string; readonly resourceId: string; readonly resourceType: string },
) =>
  result.some(
    (candidate) =>
      candidate.resourceType === relationship.resourceType &&
      candidate.resourceId === relationship.resourceId &&
      candidate.relation === relationship.relation,
  );

it('classifies read and write permissions', () => {
  expect(isReadPermission('demo_crm.read_all')).toBe(true);
  expect(isReadPermission('customer.group.read')).toBe(true);
  expect(isReadPermission('demo_crm.write_all')).toBe(false);
  expect(isReadPermission('demo.crm.assign')).toBe(false);
});

it('derives the highest access per non-Core company module', () => {
  expect(agentModuleAccessOf(template, company)).toEqual([
    { access: 'write', moduleId: 'demo.crm' },
    { access: 'write', moduleId: 'work.tasks' },
  ]);
});

it('keeps write grants for direct write policy and drops other modules and Core identity', () => {
  const result = agentGrantRelationships({
    legalEntityId: company,
    modules: [
      { access: 'write', moduleId: 'demo.crm' },
      { access: 'read', moduleId: 'work.tasks' },
    ],
    template,
    writePolicy: 'direct',
  });
  expect(has(result, permission('demo.crm', 'demo_crm.write_all'))).toBe(true);
  expect(has(result, permission('demo.crm', 'demo.crm.assign'))).toBe(true);
  expect(has(result, executor('demo.crm.apply-command'))).toBe(true);
  expect(has(result, permission('work.tasks', 'work_tasks.read_all'))).toBe(true);
  expect(has(result, moduleAccess(company, 'core.shell'))).toBe(true);
  expect(has(result, { relation: 'member', resourceId: tenant, resourceType: 'tenant' })).toBe(true);
  expect(has(result, { relation: 'party_identity_reader', resourceId: tenant, resourceType: 'tenant' })).toBe(true);
  expect(has(result, { relation: 'member', resourceId: toLegalEntityAccessObjectId(tenant, company) ?? '', resourceType: 'legal_entity' })).toBe(true);

  expect(has(result, permission('work.tasks', 'work_tasks.write_all'))).toBe(false);
  expect(has(result, executor('work.tasks.apply-command'))).toBe(false);
  expect(has(result, { relation: 'identity_admin', resourceId: tenant, resourceType: 'tenant' })).toBe(false);
  expect(has(result, moduleAccess(company, 'core.identity'))).toBe(false);
  expect(has(result, executor('core.identity.manage-demo-account'))).toBe(false);
  expect(has(result, { relation: 'counterparty_manager', resourceId: toLegalEntityAccessObjectId(tenant, company) ?? '', resourceType: 'legal_entity' })).toBe(false);
  expect(has(result, moduleAccess(other, 'demo.crm'))).toBe(false);
});

it('caps write grants to read unless the write policy is direct', () => {
  for (const writePolicy of ['approval', 'read_only'] as const) {
    const result = agentGrantRelationships({
      legalEntityId: company,
      modules: [{ access: 'write', moduleId: 'demo.crm' }],
      template,
      writePolicy,
    });
    expect(has(result, permission('demo.crm', 'demo_crm.write_all'))).toBe(false);
    expect(has(result, permission('demo.crm', 'demo.crm.assign'))).toBe(false);
    expect(has(result, executor('demo.crm.apply-command'))).toBe(false);
    expect(has(result, permission('demo.crm', 'demo_crm.read_all'))).toBe(true);
  }
});

it('grants no module-specific access when no module is chosen', () => {
  const result = agentGrantRelationships({ legalEntityId: company, modules: [], template, writePolicy: 'direct' });
  expect(has(result, moduleAccess(company, 'demo.crm'))).toBe(false);
  expect(has(result, { relation: 'member', resourceId: tenant, resourceType: 'tenant' })).toBe(true);
  expect(has(result, moduleAccess(company, 'core.shell'))).toBe(true);
});
