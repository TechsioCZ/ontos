import path from 'node:path';
import { describe, expect, it } from '@rstest/core';
import { discoverCatalog } from '../src/catalog/discover.ts';
import { commandInputSchema, taggedVariants, toolNameOf } from '../src/catalog/json-schema.ts';

const manifestModule = (moduleId: string, appId: string, apiKeys: readonly string[], actionKeys: readonly string[]) => ({
  moduleId,
  deployment: { appId },
  contractDocument: JSON.stringify({
    manifest: {
      module: { displayName: moduleId },
      publicSurface: {
        api: apiKeys.map((key) => ({ key })),
        actions: actionKeys.map((actionKey) => ({ actionKey })),
      },
    },
  }),
});

const tagged = (tag: string, properties: Record<string, unknown> = {}) => ({
  type: 'object',
  properties: { _tag: { type: 'string', enum: [tag] }, ...properties },
  required: ['_tag', ...Object.keys(properties)],
});

describe('capability catalog helpers', () => {
  it('builds snake_case MCP tool names', () => {
    expect(toolNameOf('work-tasks', 'CreateTask')).toBe('work_tasks__create_task');
    expect(toolNameOf('party-registry', 'read_customer-list')).toBe('party_registry__read_customer_list');
  });

  it('shortens long tool names deterministically with a hash suffix', () => {
    const name = toolNameOf('work-tasks', 'x'.repeat(90));
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[a-z0-9_]+$/u);
    expect(toolNameOf('work-tasks', 'x'.repeat(90))).toBe(name);
  });

  it('finds tagged variants through nested anyOf and $ref in source order', () => {
    const defs = { C: tagged('C') };
    const node = {
      anyOf: [{ anyOf: [tagged('A'), tagged('B')] }, { $ref: '#/$defs/C' }],
    };
    expect(taggedVariants(node, defs).map((variant) => variant.tag)).toEqual(['A', 'B', 'C']);
  });

  it('drops _tag from a command input and adds expectedRevision', () => {
    const schema = commandInputSchema(tagged('CreateTask', { title: { type: 'string' } }), {});
    const properties = schema['properties'] as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(['expectedRevision', 'title']);
    expect(schema['required']).toEqual(['title']);
    expect(properties['expectedRevision']).toMatchObject({ type: 'integer', minimum: 0 });
  });
});

describe('capability catalog discovery', () => {
  it(
    'joins the active composition with the vertical contracts',
    async () => {
      const composition = {
        composition: {
          revision: 'r1',
          modules: [
            manifestModule('work.tasks', 'work-tasks', ['work.tasks.records'], ['work.tasks.apply-command']),
            manifestModule('demo.crm', 'crm', ['demo.crm.records'], ['demo.crm.apply-command']),
            manifestModule('party.registry', 'party-registry', ['party.registry.customer-list'], []),
          ],
        },
      };
      const catalog = await discoverCatalog({
        composition,
        verticalsRoot: path.resolve(process.cwd(), '../../verticals'),
        extractScript: path.resolve(process.cwd(), 'src/catalog/extract-contracts.ts'),
      });

      expect(catalog.compositionRevision).toBe('r1');

      const work = catalog.modules.find((module) => module.moduleId === 'work.tasks');
      expect(work?.reads.map((read) => read.id)).toContain('work.tasks/read/records');
      expect(work?.probeReadSlug).toBe('records');
      expect(work?.supportsAiProposals).toBe(false);
      const createTask = work?.actions.find((action) => action.id === 'work.tasks/command/CreateTask');
      expect(createTask?.toolName).toBe('work_tasks__create_task');
      expect(createTask?.commandTag).toBe('CreateTask');
      const properties = createTask?.inputSchema['properties'] as Record<string, unknown>;
      expect(properties).toHaveProperty('title');
      expect(properties).toHaveProperty('expectedRevision');
      expect(properties).not.toHaveProperty('_tag');

      const crm = catalog.modules.find((module) => module.moduleId === 'demo.crm');
      expect(crm?.supportsAiProposals).toBe(true);
      expect(crm?.actions.find((action) => action.id === 'demo.crm/command/UpdateClient')?.proposable).toBe(true);
      expect(crm?.actions.find((action) => action.id === 'demo.crm/command/AiDecideChanges')?.proposable).toBe(false);

      const registry = catalog.modules.find((module) => module.moduleId === 'party.registry');
      expect(registry?.probeReadSlug).toBe('customer-list');
    },
    90_000,
  );
});
