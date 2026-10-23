import { expect, it } from 'effect-rstest';

import {
  commandRevisionFrom,
  composedModulesOf,
  revisionQueryOf,
} from '../../../api/agent-platform/composed-modules.ts';
import { buildMcpModules } from '../../../api/mcp/catalog.ts';
import { FIXTURE_APP_ID, FIXTURE_MODULE_ID, fixtureComposition, fixtureModule } from '../mcp/fixture-vertical.ts';
import type { McpModule } from '../../../api/mcp/catalog.ts';

const modules = composedModulesOf(buildMcpModules(fixtureComposition));

/** A module with one revision per part, declared in its contribution (prefix -> field). */
const partitioned: McpModule = {
  ...(modules.byAppId(FIXTURE_APP_ID) as McpModule),
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

it('decodes and projects module-owned activity destinations, rejecting non-local routes', () => {
  const source = modules.byAppId(FIXTURE_APP_ID);
  if (source === undefined) throw new Error('Fixture contribution is missing');
  const recordLink = {
    commands: [{ tag: 'UpdateNote', idField: 'noteId' }],
    idField: 'id',
    labelField: 'title',
    path: '/notes',
    queryParam: 'note',
    recordsPath: 'state.notes',
    resourceType: 'fixture.note',
  };
  const directory = (path: string) =>
    buildMcpModules({
      revision: fixtureComposition.revision,
      modules: [
        fixtureModule(
          FIXTURE_MODULE_ID,
          FIXTURE_APP_ID,
          JSON.stringify({
            manifest: {
              publicSurface: {
                mcp: {
                  agentAdministrationPage: '/people',
                  approvals: source.approvals,
                  description: source.description,
                  keywords: source.keywords,
                  label: source.label,
                  page: source.page,
                  recordLinks: [{ ...recordLink, path }],
                  revision: source.revision,
                  toolCatalog: source.toolCatalog,
                },
              },
            },
          }),
          'http://127.0.0.1:9',
        ),
      ],
    });
  const projected = directory('/notes');
  expect(projected.warnings).toEqual([]);
  expect(projected.modules[0]?.recordLinks).toEqual([recordLink]);
  expect(projected.modules[0]?.agentAdministrationPage).toBe('/people');
  expect(directory('https://outside.example/record').modules).toEqual([]);
  expect(directory('//outside.example').modules).toEqual([]);
});
