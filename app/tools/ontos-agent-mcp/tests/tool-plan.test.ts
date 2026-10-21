// Tool plan per ConnectionDescription. Pure: no shell, no network.
// Run: pnpm --dir tools/ontos-agent-mcp exec rstest run tests/tool-plan.test.ts
import assert from 'node:assert/strict';
import { describe, it } from '@rstest/core';
import type { Catalog, CatalogAction, CatalogModule, CatalogRead } from '../src/capabilities/types.ts';
import type { ConnectionDescription, ConnectionWritePolicy } from '../src/oauth/types.ts';
import { annotationsFor, planTools } from '../src/mcp/tool-plan.ts';

const workRead: CatalogRead = {
  appId: 'work-tasks',
  id: 'work.tasks/read/records',
  inputSchema: { type: 'object' },
  kind: 'read',
  moduleId: 'work.tasks',
  slug: 'records',
  toolName: 'work_tasks__read_records',
};
const createTask: CatalogAction = {
  actionSlug: 'apply-command',
  appId: 'work-tasks',
  commandTag: 'CreateTask',
  id: 'work.tasks/command/CreateTask',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  kind: 'action',
  moduleId: 'work.tasks',
  proposable: true,
  toolName: 'work_tasks__create_task',
};
const cancelTask: CatalogAction = {
  ...createTask,
  commandTag: 'CancelTask',
  id: 'work.tasks/command/CancelTask',
  proposable: false,
  toolName: 'work_tasks__cancel_task',
};
const aiPropose: CatalogAction = {
  ...createTask,
  commandTag: 'AiProposeChanges',
  id: 'work.tasks/command/AiProposeChanges',
  proposable: false,
  toolName: 'work_tasks__ai_propose_changes',
};
const crmRead: CatalogRead = {
  appId: 'crm',
  id: 'demo.crm/read/records',
  inputSchema: { type: 'object' },
  kind: 'read',
  moduleId: 'demo.crm',
  slug: 'records',
  toolName: 'crm__read_records',
};
const updateClient: CatalogAction = {
  actionSlug: 'apply-command',
  appId: 'crm',
  commandTag: 'UpdateClient',
  id: 'demo.crm/command/UpdateClient',
  inputSchema: { type: 'object' },
  kind: 'action',
  moduleId: 'demo.crm',
  proposable: true,
  toolName: 'crm__update_client',
};
const moduleOf = (
  moduleId: string,
  appId: string,
  reads: CatalogRead[],
  actions: CatalogAction[],
): CatalogModule => ({
  actions,
  appId,
  displayName: moduleId,
  moduleId,
  probeReadSlug: 'records',
  reads,
  supportsAiProposals: true,
  typedTools: true,
});
const CATALOG: Catalog = {
  compositionRevision: 'a'.repeat(64),
  modules: [
    moduleOf('work.tasks', 'work-tasks', [workRead], [createTask, cancelTask, aiPropose]),
    moduleOf('demo.crm', 'crm', [crmRead], [updateClient]),
  ],
  warnings: [],
};
const describe_ = (writePolicy: ConnectionWritePolicy, write = true): ConnectionDescription => ({
  acting: { displayName: 'Petra Správcová', kind: 'human', principalId: 'principal-1' },
  client: { clientId: 'client-1', host: 'claude.ai', kind: 'cimd', name: 'Claude' },
  compositionRevision: 'a'.repeat(64),
  delegatedBy: null,
  grantId: 'grant-1',
  legalEntityId: '71000000-0000-4000-8000-000000000021',
  legalName: 'Siampark',
  modules: [{ label: 'Úkoly', moduleId: 'work.tasks', read: true, write }],
  profileId: 'profile-1',
  status: 'active',
  tenantId: 'tenant-1',
  writePolicy,
});
const GENERIC_READ = ['ontos_whoami', 'ontos_capabilities', 'ontos_read', 'ontos_list_proposals'];

describe('planTools', () => {
  it('read_only offers only read tools and the read typed tool', () => {
    const plan = planTools(CATALOG, describe_('read_only'));
    assert.deepEqual([...plan.generic], GENERIC_READ);
    assert.deepEqual(
      plan.typed.map((entry) => entry.toolName),
      ['work_tasks__read_records'],
    );
  });

  it('approval adds the write generic tools and only proposable typed commands', () => {
    const plan = planTools(CATALOG, describe_('approval'));
    assert.deepEqual([...plan.generic], [...GENERIC_READ, 'ontos_execute', 'ontos_propose']);
    assert.deepEqual(
      plan.typed.map((entry) => entry.toolName),
      ['work_tasks__read_records', 'work_tasks__create_task'],
    );
  });

  it('direct offers every granted command except the AI meta command', () => {
    const plan = planTools(CATALOG, describe_('direct'));
    assert.deepEqual(
      plan.typed.map((entry) => entry.toolName),
      ['work_tasks__read_records', 'work_tasks__create_task', 'work_tasks__cancel_task'],
    );
    assert.ok(!plan.typed.some((entry) => entry.toolName.includes('ai_propose')));
  });

  it('direct with write=false offers only the read typed tool', () => {
    const plan = planTools(CATALOG, describe_('direct', false));
    assert.deepEqual(
      plan.typed.map((entry) => entry.toolName),
      ['work_tasks__read_records'],
    );
  });

  it('never offers tools of a module the grant does not include', () => {
    for (const policy of ['read_only', 'approval', 'direct'] as const) {
      const plan = planTools(CATALOG, describe_(policy));
      assert.ok(!plan.typed.some((entry) => entry.toolName.startsWith('crm__')));
    }
  });

  it('drops all typed tools when the candidates exceed the cap', () => {
    const reads: CatalogRead[] = Array.from({ length: 41 }, (_, index) => ({
      ...workRead,
      id: `work.tasks/read/r${index}`,
      slug: `r${index}`,
      toolName: `work_tasks__read_r${index}`,
    }));
    const big: Catalog = { ...CATALOG, modules: [moduleOf('work.tasks', 'work-tasks', reads, [])] };
    const plan = planTools(big, describe_('read_only'));
    assert.deepEqual([...plan.typed], []);
    assert.equal(plan.typedOverCap, true);
    assert.equal(plan.typedCandidates, 41);
  });

  it('annotations: destructive commands are flagged, reads are read-only', () => {
    assert.equal(annotationsFor(cancelTask).destructiveHint, true);
    assert.equal(annotationsFor(createTask).destructiveHint, false);
    assert.equal(annotationsFor(workRead).readOnlyHint, true);
  });
});
