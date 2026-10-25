// @rstest-environment node
import { NodeCrypto } from '@effect/platform-node';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/client';
import { Crypto, Effect, Layer, Option } from 'effect';
import { HttpRouter } from 'effect/unstable/http';
import { describe, expect, it } from 'effect-rstest';

import { ShellCryptoLive } from '../../../api/auth/gateway-issuer.ts';
import { AgentActionRequestIdentity } from '../../../api/auth/agent-action-request-identity.ts';
import { mcpRequestIdentityMiddleware } from '../../../api/index.ts';
import type { JsonObject } from '../../../api/mcp/catalog.ts';
import { serveMcp } from '../../../api/mcp/http.ts';
import { buildConnectionTools } from '../../../api/mcp/tools.ts';
import { serveMcpHttpAdapter, withMcpActionIntent } from '../../../api/mcp/transport.ts';
import type { McpBackend } from '../../../api/mcp/types.ts';
import { connectionDescription, fixtureCatalog, FIXTURE_MODULE_ID } from './fixture-vertical.ts';

const RESOURCE = 'https://intent.ontos.test/mcp';
const VERSION = '2026-07-28';
const DESCRIPTION = connectionDescription({ writePolicy: 'approval' });
const CONFIG = {
  issuer: 'https://intent.ontos.test/oauth',
  prmUrl: 'https://intent.ontos.test/.well-known/oauth-protected-resource/mcp',
  publicOrigin: 'https://intent.ontos.test',
  resource: RESOURCE,
};

interface Submission {
  readonly action: Option.Option<(typeof AgentActionRequestIdentity)['Service']>;
  readonly intent: Parameters<McpBackend['submitProposals']>[1];
  readonly request: Parameters<McpBackend['submitProposals']>[0];
}

// Protocol/port observer only: no claim that this observer exercises native proposal persistence or OAuth.
// action-intent.test.ts separately exercises the actual binding against Core's native Action runtime.
const acquireServer = (submissions: Submission[], correlations: string[]) =>
  Effect.acquireRelease(
    Effect.gen(function* makeCallerIntentServer() {
      const crypto = yield* Effect.service(Crypto.Crypto).pipe(Effect.provide(ShellCryptoLive));
      const backend: McpBackend = {
        callModule: () => Effect.die('Approval tools must not invoke module mutations'),
        listProposals: Effect.die('This test does not list proposals'),
        submitProposals: (request, intent) =>
          withMcpActionIntent(
            Effect.gen(function* observeSubmission() {
              submissions.push({ action: yield* Effect.serviceOption(AgentActionRequestIdentity), intent, request });
              return {
                batchId: 'observed-batch',
                proposalIds: ['observed-proposal'],
                replayed: false,
                reviewPath: '/cs/sprava/ke-schvaleni',
              };
            }),
            intent,
          ),
      };
      const tools = () =>
        buildConnectionTools({
          backend,
          catalog: fixtureCatalog(),
          crypto,
          description: DESCRIPTION,
          prmUrl: CONFIG.prmUrl,
          publicOrigin: CONFIG.publicOrigin,
        });
      const respond = serveMcp({
        authenticate: (token) =>
          Effect.succeed(
            token === 'test-bearer'
              ? { clientId: DESCRIPTION.client.clientId, grantId: DESCRIPTION.grantId, kind: 'ok' as const, tools }
              : { kind: 'invalid' as const },
          ),
        config: Effect.succeed(CONFIG),
      });
      const routes = HttpRouter.add(
        'POST',
        '/mcp',
        serveMcpHttpAdapter((request) => {
          expect(request.headers.get('idempotency-key')).toBeNull();
          const correlation = request.headers.get('x-correlation-id');
          expect(correlation).not.toBeNull();
          if (correlation !== null) {
            correlations.push(correlation);
          }
          return respond(request);
        }),
      ).pipe(Layer.provide(mcpRequestIdentityMiddleware.layer.pipe(Layer.provide(NodeCrypto.layer))));
      return HttpRouter.toWebHandler(routes, { disableLogger: true });
    }),
    (server) => Effect.promise(() => server.dispose()),
  );

const callRequest = (name: string, args: JsonObject, id: number) =>
  new Request(RESOURCE, {
    body: JSON.stringify({
      id,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: { name: 'standard-mcp-protocol-fixture', version: '1.0.0' },
          [PROTOCOL_VERSION_META_KEY]: VERSION,
        },
        arguments: args,
        name,
      },
    }),
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer test-bearer',
      'content-type': 'application/json',
      'mcp-method': 'tools/call',
      'mcp-name': name,
      'mcp-protocol-version': VERSION,
    },
    method: 'POST',
  });

const execution = {
  id: `${FIXTURE_MODULE_ID}/command/AddNote`,
  input: { text: 'Původní vstup' },
  reason: 'Výslovné přání',
  runId: 'actual-agent-run',
};
const batch = {
  changes: [{ id: execution.id, input: execution.input, reason: execution.reason }],
  instruction: 'Dvě změny ve stejném běhu',
  runId: execution.runId,
};

describe('standard MCP per-tool mutation intent', () => {
  it.live(
    'crosses the real HTTP adapter without a custom key header and retains exact caller intent and run across retries',
    () =>
      Effect.gen(function* standardCallIntent() {
        const submissions: Submission[] = [];
        const correlations: string[] = [];
        const server = yield* acquireServer(submissions, correlations);
        const args = { ...execution, idempotencyKey: 'Caller-Intent:AbC_123/retry' };
        for (const id of [1, 2]) {
          const response = yield* Effect.promise(() => server.handler(callRequest('ontos_execute', args, id)));
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            result: { structuredContent: { status: 'proposed' } },
          });
        }
        expect(submissions).toHaveLength(2);
        expect(submissions[0]?.request).toEqual(submissions[1]?.request);
        expect(submissions[0]?.request).toMatchObject({
          proposals: [{ command: { _tag: 'AddNote', text: 'Původní vstup' } }],
          runId: execution.runId,
        });
        expect(submissions.map(({ intent }) => intent.idempotencyKey)).toEqual([
          args.idempotencyKey,
          args.idempotencyKey,
        ]);
        expect(submissions.map(({ action }) => Option.getOrNull(action))).toEqual(
          correlations.map((correlationId) => ({ correlationId, idempotencyKey: args.idempotencyKey })),
        );
        expect(new Set(correlations).size).toBe(2);
      }),
  );

  it.live(
    'refuses absent, wrong-type, empty, whitespace and oversized keys on every mutation tool before the port',
    () =>
      Effect.gen(function* invalidCallIntents() {
        const submissions: Submission[] = [];
        const server = yield* acquireServer(submissions, []);
        for (const [name, args] of [
          ['ontos_execute', execution],
          ['ontos_propose', batch],
          ['fixture_notes__add_note', { text: 'Původní vstup' }],
        ] as const) {
          for (const keyFields of [
            {},
            { idempotencyKey: 3 },
            { idempotencyKey: '' },
            { idempotencyKey: ' ' },
            { idempotencyKey: 'x'.repeat(201) },
          ]) {
            const response = yield* Effect.promise(() =>
              server.handler(callRequest(name, { ...args, ...keyFields }, 1)),
            );
            expect(response.status).toBe(200);
            expect(yield* Effect.promise(() => response.json())).toMatchObject({
              result: { _meta: { 'ontos/code': 'invalid_arguments' }, isError: true },
            });
          }
        }
        expect(submissions).toHaveLength(0);
      }),
  );

  it.live(
    'keeps independent keys for typed, generic and batch calls and never substitutes a generated run identity',
    () =>
      Effect.gen(function* separateToolIntents() {
        const submissions: Submission[] = [];
        const server = yield* acquireServer(submissions, []);
        for (const [name, args] of [
          ['ontos_execute', { ...execution, idempotencyKey: 'execute-intent' }],
          ['fixture_notes__add_note', { idempotencyKey: 'typed-intent', text: 'Jiný návrh' }],
          ['ontos_propose', { ...batch, idempotencyKey: 'batch-intent' }],
          ['ontos_propose', { ...batch, idempotencyKey: 'batch-intent' }],
          ['ontos_propose', { ...batch, idempotencyKey: 'next-batch-intent' }],
        ] as const) {
          const response = yield* Effect.promise(() => server.handler(callRequest(name, args, 1)));
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            result: { structuredContent: { status: 'proposed' } },
          });
        }
        expect(submissions.map(({ intent }) => intent.idempotencyKey)).toEqual([
          'execute-intent',
          'typed-intent',
          'batch-intent',
          'batch-intent',
          'next-batch-intent',
        ]);
        expect(submissions.map(({ request }) => request.runId)).toEqual([
          execution.runId,
          undefined,
          execution.runId,
          execution.runId,
          execution.runId,
        ]);
        expect(submissions[2]?.request).toEqual(submissions[3]?.request);
        expect(submissions[2]?.intent).toEqual(submissions[3]?.intent);
      }),
  );
});
