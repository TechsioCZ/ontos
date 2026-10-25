// @rstest-environment node
import { Crypto, Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ShellCryptoLive } from '../../../api/auth/gateway-issuer.ts';
import type { McpCatalog } from '../../../api/mcp/catalog.ts';
import { buildConnectionTools } from '../../../api/mcp/tools.ts';
import type { McpBackend, ToolSpec } from '../../../api/mcp/types.ts';
import { connectionDescription, fixtureCatalog, FIXTURE_MODULE_ID } from './fixture-vertical.ts';

const buildTools = Effect.fn('McpIntentTest.buildTools')(function* buildTools(
  backend: McpBackend,
  catalog = fixtureCatalog(),
  writePolicy: 'approval' | 'direct' = 'direct',
) {
  const crypto = yield* Effect.service(Crypto.Crypto).pipe(Effect.provide(ShellCryptoLive));
  return buildConnectionTools({
    backend,
    catalog,
    crypto,
    description: connectionDescription({ writePolicy }),
    prmUrl: 'https://intent.test/.well-known/oauth-protected-resource/mcp',
    publicOrigin: 'https://intent.test',
  });
});
const toolOf = (tools: readonly ToolSpec[], name: string): ToolSpec => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`Missing tool ${name}`);
  }
  return tool;
};
const noBackend: McpBackend = {
  callModule: () => Effect.die('Invalid arguments must not reach a module'),
  listProposals: Effect.die('No proposal queue reads expected'),
  submitProposals: () => Effect.die('Invalid arguments must not reach proposal submission'),
};
const collidingCatalog = (): McpCatalog => {
  const catalog = fixtureCatalog();
  return {
    ...catalog,
    modules: catalog.modules.map((module) => ({
      ...module,
      tools: module.tools.map((tool) =>
        tool.name === 'fixture_notes__add_note'
          ? {
              ...tool,
              inputSchema: {
                additionalProperties: false,
                properties: {
                  idempotencyKey: { type: 'integer' },
                  reason: { type: 'string' },
                  runId: { type: 'string' },
                  text: { type: 'string' },
                },
                required: ['idempotencyKey', 'reason', 'runId', 'text'],
                type: 'object',
              },
            }
          : tool,
      ),
    })),
  };
};

describe('mutation schemas keep caller intent separate from Action-owned fields', () => {
  it.effect('requires a bounded caller key on generic, batch and noncolliding typed writes', () =>
    Effect.gen(function* requiredMutationKeys() {
      const tools = yield* buildTools(noBackend);
      for (const [name, args] of [
        ['ontos_execute', { id: `${FIXTURE_MODULE_ID}/command/AddNote`, input: { text: 'Note' } }],
        [
          'ontos_propose',
          {
            changes: [{ id: `${FIXTURE_MODULE_ID}/command/AddNote`, input: { text: 'Note' }, reason: 'Requested' }],
            instruction: 'Requested changes',
          },
        ],
        ['fixture_notes__add_note', { text: 'Note' }],
      ] as const) {
        const tool = toolOf(tools, name);
        expect(tool.inputSchema['required']).toContain('idempotencyKey');
        for (const keyFields of [
          {},
          { idempotencyKey: null },
          { idempotencyKey: '' },
          { idempotencyKey: ' ' },
          { idempotencyKey: 'x'.repeat(201) },
        ]) {
          const result = yield* tool.handler({ ...args, ...keyFields });
          expect(result.isError).toBe(true);
          expect(result._meta).toEqual({ 'ontos/code': 'invalid_arguments' });
        }
      }
      expect(toolOf(tools, 'fixture_notes__read_records').inputSchema['required']).toBeUndefined();
    }),
  );

  it.effect('plans genuine key collisions through the generic wrapper, preserving all Action-owned fields', () =>
    Effect.gen(function* preserveCollidingActionFields() {
      const calls: { readonly body: unknown; readonly key: string | undefined }[] = [];
      const backend: McpBackend = {
        ...noBackend,
        callModule: (_appId, path, body, options) =>
          Effect.sync(() => {
            if (path === '/reads/records') {
              return { body: { canWrite: true, revision: 7 }, status: 200 };
            }
            calls.push({ body, key: options.idempotencyKey });
            return { body: { ok: true }, status: 200 };
          }),
      };
      const tools = yield* buildTools(backend, collidingCatalog());
      expect(tools.map(({ name }) => name)).not.toContain('fixture_notes__add_note');
      expect(tools.map(({ name }) => name)).toContain('fixture_notes__read_records');
      const capability = yield* toolOf(tools, 'ontos_capabilities').handler({
        id: `${FIXTURE_MODULE_ID}/command/AddNote`,
      });
      expect(capability.structuredContent).toMatchObject({
        inputSchema: { properties: { idempotencyKey: { type: 'integer' } } },
        toolName: 'ontos_execute',
      });
      const input = { idempotencyKey: 47, reason: 'Action-owned reason', runId: 'Action-owned run', text: 'Note' };
      const result = yield* toolOf(tools, 'ontos_execute').handler({
        id: `${FIXTURE_MODULE_ID}/command/AddNote`,
        idempotencyKey: 'outer-caller-key',
        input,
      });
      expect(result.isError).not.toBe(true);
      expect(calls).toEqual([
        { body: { command: { ...input, _tag: 'AddNote' }, expectedRevision: 7 }, key: 'outer-caller-key' },
      ]);
    }),
  );

  it.effect('does not consume Action-owned key/reason/run fields when creating proposals', () =>
    Effect.gen(function* preserveProposedActionFields() {
      const proposals: Parameters<McpBackend['submitProposals']>[] = [];
      const tools = yield* buildTools(
        {
          ...noBackend,
          submitProposals: (request, intent) =>
            Effect.sync(() => {
              proposals.push([request, intent]);
              return {
                batchId: 'batch',
                proposalIds: ['proposal'],
                replayed: false,
                reviewPath: '/cs/sprava/ke-schvaleni',
              };
            }),
        },
        collidingCatalog(),
        'approval',
      );
      const input = { idempotencyKey: 47, reason: 'Action-owned reason', runId: 'Action-owned run', text: 'Note' };
      const result = yield* toolOf(tools, 'ontos_execute').handler({
        id: `${FIXTURE_MODULE_ID}/command/AddNote`,
        idempotencyKey: 'proposal-caller-key',
        input,
        reason: 'Proposal reason',
        runId: 'real-run',
      });
      expect(result.isError).not.toBe(true);
      expect(proposals).toEqual([
        [
          expect.objectContaining({
            proposals: [expect.objectContaining({ command: { ...input, _tag: 'AddNote' }, reason: 'Proposal reason' })],
            runId: 'real-run',
          }),
          { idempotencyKey: 'proposal-caller-key' },
        ],
      ]);
    }),
  );
});
