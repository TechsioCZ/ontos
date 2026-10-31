// @rstest-environment node
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from '@effect/platform-node/Undici';

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

/** The native release transport receives in-memory HTTP replies, retaining real body and digest handling. */
const release = Effect.acquireRelease(
  Effect.sync(() => {
    const previousDispatcher = getGlobalDispatcher();
    const agent = new MockAgent();
    const origin = 'http://127.0.0.1:9';
    const reads: string[] = [];
    agent.disableNetConnect();
    agent
      .get(origin)
      .intercept({ method: 'GET', path: /.*/u })
      .reply(({ path }) => {
        reads.push(path);
        if (path === FIXTURE_TOOL_CATALOG_PATH) {
          return {
            data: FIXTURE_TOOL_CATALOG_TEXT,
            responseOptions: { headers: { 'content-type': 'application/json' } },
            statusCode: 200,
          };
        }
        return { data: '', statusCode: 404 };
      })
      .persist();
    setGlobalDispatcher(agent);
    return { agent, origin, previousDispatcher, reads };
  }),
  ({ agent, previousDispatcher }) =>
    Effect.sync(() => {
      setGlobalDispatcher(previousDispatcher);
    }).pipe(Effect.andThen(Effect.promise(agent.close.bind(agent)))),
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
