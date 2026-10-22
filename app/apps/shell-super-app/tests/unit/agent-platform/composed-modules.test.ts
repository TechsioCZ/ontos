import { expect, it } from 'effect-rstest';

import { commandRevisionFrom, composedModulesOf, revisionQueryOf } from '../../../api/agent-platform/composed-modules.ts';
import { buildMcpCatalog } from '../../../api/mcp/catalog.ts';
import { FIXTURE_APP_ID, FIXTURE_MODULE_ID, fixtureComposition } from '../mcp/fixture-vertical.ts';
import type { McpCatalogModule } from '../../../api/mcp/catalog.ts';

const modules = composedModulesOf(buildMcpCatalog(fixtureComposition));

/** A module with one revision per part, declared in its contribution (prefix -> field). */
const partitioned: McpCatalogModule = {
  ...(modules.byAppId(FIXTURE_APP_ID) as McpCatalogModule),
  revision: {
    field: 'revision',
    fieldsByCommandPrefix: [
      { field: 'parts.alpha.revision', prefix: 'Alpha' },
      { field: 'parts.beta.revision', prefix: 'Beta' },
    ],
    path: '/reads/records',
    query: { view: {} },
  },
};

it('labels modules from their contributions, the platform and unknown keys', () => {
  expect(modules.labelOf(FIXTURE_MODULE_ID)).toBe('Poznámky');
  expect(modules.labelOf(null)).toBe('Platforma');
  expect(modules.labelOf('other.module')).toBe('other.module');
  expect(modules.byAppId(FIXTURE_APP_ID)?.approvals).toBe(true);
  expect(modules.byAppId('fixture-silent')).toBeUndefined();
});

it('reads the revision where the contribution says', () => {
  expect(commandRevisionFrom(modules.byAppId(FIXTURE_APP_ID), { revision: 7 }, { _tag: 'AddNote' })).toBe(7);
  const body = { parts: { alpha: { revision: 115 }, beta: { revision: 3 } }, revision: 1 };
  expect(commandRevisionFrom(partitioned, body, { _tag: 'AlphaUpdate' })).toBe(115);
  expect(commandRevisionFrom(partitioned, body, { _tag: 'BetaCreate' })).toBe(3);
  expect(commandRevisionFrom(partitioned, body, { _tag: 'Other' })).toBe(1);
  expect(commandRevisionFrom(partitioned, { parts: {} }, { _tag: 'AlphaUpdate' })).toBeUndefined();
  expect(revisionQueryOf(partitioned)).toEqual({ view: {} });
  expect(revisionQueryOf(undefined)).toEqual({});
});
