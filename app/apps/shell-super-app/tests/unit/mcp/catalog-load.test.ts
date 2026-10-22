// @rstest-environment node
import { createServer } from 'node:http';

import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { loadMcpCatalog, mcpModulesOf } from '../../../api/mcp/catalog.ts';
import {
  FIXTURE_APP_ID,
  FIXTURE_CONTRACT_DOCUMENT,
  FIXTURE_MODULE_ID,
  FIXTURE_TOOL_CATALOG_PATH,
  FIXTURE_TOOL_CATALOG_TEXT,
  fixtureCompositionAt,
  fixtureModule,
} from './fixture-vertical.ts';

interface Release {
  readonly close: () => void;
  readonly origin: string;
  readonly reads: string[];
}

/** A module release on loopback that serves the fixture tool catalog and records each read. */
const release = Effect.acquireRelease(
  Effect.callback<Release>((resume) => {
    const reads: string[] = [];
    const server = createServer((request, response) => {
      reads.push(request.url ?? '');
      if (request.url === FIXTURE_TOOL_CATALOG_PATH) {
        response.writeHead(200, { 'content-type': 'application/json' }).end(FIXTURE_TOOL_CATALOG_TEXT);
      } else {
        response.writeHead(404).end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resume(Effect.succeed({ close: () => server.close(), origin: `http://127.0.0.1:${port}`, reads }));
    });
  }),
  ({ close }) => Effect.sync(close),
);

it('describes modules from their contracts without loading any tool', () => {
  const directory = mcpModulesOf(fixtureCompositionAt('http://127.0.0.1:9', '1'.repeat(64)));
  expect(directory.modules.map((module) => module.moduleId)).toEqual([FIXTURE_MODULE_ID]);
  expect(directory.modules[0]?.toolCatalog).toMatchObject({ path: FIXTURE_TOOL_CATALOG_PATH, toolCount: 3 });
});

it.effect('loads tools from the module release once per digest and per revision', () =>
  Effect.gen(function* loadsOnce() {
    const { origin, reads } = yield* release;
    const first = yield* loadMcpCatalog(fixtureCompositionAt(origin, '2'.repeat(64)));
    expect(first.warnings).toEqual([]);
    expect(first.modules[0]?.tools.map((tool) => tool.name)).toEqual([
      'fixture_notes__read_records',
      'fixture_notes__add_note',
      'fixture_notes__wipe_notes',
    ]);
    expect(first.modules[0]?.tools[1]?.inputSchema['$defs']).toEqual({
      NoteText: { maxLength: 200, minLength: 1, type: 'string' },
    });
    expect(yield* loadMcpCatalog(fixtureCompositionAt(origin, '2'.repeat(64)))).toBe(first);
    // A new revision pinning the same digest reuses the verified tools.
    yield* loadMcpCatalog(fixtureCompositionAt(origin, '3'.repeat(64)));
    expect(reads).toEqual([FIXTURE_TOOL_CATALOG_PATH]);
  }).pipe(Effect.scoped),
);

it.effect('leaves out a module whose served tools do not match the pinned digest, and asks again', () =>
  Effect.gen(function* rejectsDrift() {
    const { origin, reads } = yield* release;
    // The contract pins a different digest than the release serves.
    const composition = {
      modules: [
        fixtureModule(
          FIXTURE_MODULE_ID,
          FIXTURE_APP_ID,
          FIXTURE_CONTRACT_DOCUMENT.replace(/"sha256":"[0-9a-f]{64}"/u, `"sha256":"${'a'.repeat(64)}"`),
          origin,
        ),
      ],
      revision: '4'.repeat(64),
    };
    const drifted = yield* loadMcpCatalog(composition);
    expect(drifted.modules).toEqual([]);
    expect(drifted.warnings).toEqual([
      `${FIXTURE_MODULE_ID}: MCP tools are unavailable (artifact does not match the pinned digest)`,
    ]);
    yield* loadMcpCatalog(composition);
    expect(reads).toHaveLength(2);
  }).pipe(Effect.scoped),
);
