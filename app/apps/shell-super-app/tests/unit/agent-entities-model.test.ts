import { AgentModuleKeySchema } from '@app/shared-contracts/agent-proposals';
import { expect, test } from 'effect-rstest';

import { agentCatalogOf, agentModuleOptions } from '../../api/auth/agent-entities-model.ts';

/** Labels the composed modules declare in their contributions. */
const LABELS = new Map([
  ['facility.operations', 'Provoz'],
  ['work.tasks', 'Úkoly a projekty'],
]);
const labelOf = (moduleId: string): string => LABELS.get(moduleId) ?? moduleId;
const key = (moduleId: string) => AgentModuleKeySchema.make(moduleId);

test('module options carry the highest access and are sorted by Czech label', () => {
  expect(
    agentModuleOptions(
      [
        { access: 'write', moduleId: key('work.tasks') },
        { access: 'read', moduleId: key('facility.operations') },
      ],
      labelOf,
    ),
  ).toEqual([
    { label: 'Provoz', maxAccess: 'read', moduleId: key('facility.operations') },
    { label: 'Úkoly a projekty', maxAccess: 'write', moduleId: key('work.tasks') },
  ]);
});

const capabilities = [
  { key: 'work.tasks.read', kind: 'read', moduleKey: 'work.tasks' },
  { key: 'work.tasks.update', kind: 'action', moduleKey: 'work.tasks' },
  { key: 'facility.operations.read', kind: 'read', moduleKey: 'facility.operations' },
  { key: 'facility.operations.admin', kind: 'admin', moduleKey: 'facility.operations' },
  { key: 'crm.read', kind: 'read', moduleKey: 'crm' },
  { key: 'billing.export', kind: 'export', moduleKey: 'billing' },
] as const;

const catalog = agentCatalogOf({
  activeModuleKeys: ['work.tasks', 'facility.operations', 'crm'],
  capabilities,
  composedModuleKeys: ['work.tasks', 'facility.operations', 'billing'],
  labelOf,
  legalEntityId: 'company-a',
  roles: [
    {
      capabilityKeys: ['work.tasks.read', 'facility.operations.admin'],
      id: 'r-viewer',
      legalEntityId: null,
      name: 'Čtenář',
    },
    {
      capabilityKeys: ['work.tasks.update', 'facility.operations.read', 'crm.read', 'billing.export'],
      id: 'r-ops',
      legalEntityId: 'company-a',
      name: 'Provozní',
    },
    { capabilityKeys: ['work.tasks.update'], id: 'r-other', legalEntityId: 'company-b', name: 'Cizí firma' },
  ],
});

test('offers only modules active in the tenant and composed in the release, with the access their capabilities give', () => {
  // crm is not composed, billing is not active; administration is never an agent's, so it adds nothing.
  expect(catalog.options).toEqual([
    { label: 'Provoz', maxAccess: 'read', moduleId: key('facility.operations') },
    { label: 'Úkoly a projekty', maxAccess: 'write', moduleId: key('work.tasks') },
  ]);
});

test("presets are the tenant's and this company's v2 roles, in name order, with the modules an agent could use", () => {
  expect(catalog.presets).toEqual([
    { key: 'r-viewer', label: 'Čtenář', modules: [{ access: 'read', moduleId: key('work.tasks') }] },
    {
      key: 'r-ops',
      label: 'Provozní',
      modules: [
        { access: 'read', moduleId: key('facility.operations') },
        { access: 'write', moduleId: key('work.tasks') },
      ],
    },
  ]);
});
