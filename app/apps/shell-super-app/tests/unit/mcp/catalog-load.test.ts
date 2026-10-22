import { Effect } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { expect, it } from 'effect-rstest';

import { loadMcpCatalog, mcpModulesOf } from '../../../api/mcp/catalog.ts';
import {
  FIXTURE_MODULE_ID,
  FIXTURE_TOOL_CATALOG_TEXT,
  FIXTURE_TOOL_CATALOG_URL,
  fixtureComposition,
} from './fixture-vertical.ts';

/** A release origin that serves `body` for the fixture tool catalog and counts the reads. */
const releaseFetch =
  (body: () => string, reads: string[]): typeof globalThis.fetch =>
  async (input) => {
    const { url } = new Request(input);
    reads.push(url);
    return url === FIXTURE_TOOL_CATALOG_URL ? new Response(body()) : new Response('missing', { status: 404 });
  };

const compositionAt = (revision: string) => ({ ...fixtureComposition, revision });

it('describes modules from their contracts without loading any tool', () => {
  const directory = mcpModulesOf(compositionAt('1'.repeat(64)));
  expect(directory.modules.map((module) => module.moduleId)).toEqual([FIXTURE_MODULE_ID]);
  expect(directory.modules[0]?.toolCatalog).toMatchObject({ toolCount: 3, url: FIXTURE_TOOL_CATALOG_URL });
});

it.effect('loads tools from the module release once per digest and per revision', () =>
  Effect.gen(function* loadsOnce() {
    const reads: string[] = [];
    const fetch = releaseFetch(() => FIXTURE_TOOL_CATALOG_TEXT, reads);
    const first = yield* loadMcpCatalog(compositionAt('2'.repeat(64))).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    expect(first.warnings).toEqual([]);
    expect(first.modules[0]?.tools.map((tool) => tool.name)).toEqual([
      'fixture_notes__read_records',
      'fixture_notes__add_note',
      'fixture_notes__wipe_notes',
    ]);
    expect(first.modules[0]?.tools[1]?.inputSchema['$defs']).toEqual({
      NoteText: { maxLength: 200, minLength: 1, type: 'string' },
    });
    const again = yield* loadMcpCatalog(compositionAt('2'.repeat(64))).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    expect(again).toBe(first);
    // A new revision pinning the same digest reuses the verified tools.
    yield* loadMcpCatalog(compositionAt('3'.repeat(64))).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
    expect(reads).toEqual([FIXTURE_TOOL_CATALOG_URL]);
  }),
);

it.effect('leaves out a module whose served tools do not match the pinned digest, and asks again', () =>
  Effect.gen(function* rejectsDrift() {
    const reads: string[] = [];
    const fetch = releaseFetch(() => FIXTURE_TOOL_CATALOG_TEXT, reads);
    // The contract pins a different digest than the release serves.
    const composition = {
      ...fixtureComposition,
      modules: fixtureComposition.modules.map((module) => ({
        ...module,
        contractDocument: module.contractDocument.replace(/"sha256":"[0-9a-f]{64}"/u, `"sha256":"${'a'.repeat(64)}"`),
      })),
      revision: '4'.repeat(64),
    };
    const drifted = yield* loadMcpCatalog(composition).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
    expect(drifted.modules).toEqual([]);
    expect(drifted.warnings).toEqual([`${FIXTURE_MODULE_ID}: MCP tools are unavailable`]);
    yield* loadMcpCatalog(composition).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
    expect(reads).toHaveLength(2);
  }),
);
