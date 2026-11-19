// @rstest-environment node
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/client';
import { Context, Effect, Layer, Logger, Option, Tracer } from 'effect';
import { expect, it } from 'effect-rstest';

import { serveMcp } from '../../../api/mcp/http.ts';
import type { McpEndpointDeps } from '../../../api/mcp/http.ts';
import type { ToolSpec } from '../../../api/mcp/types.ts';

const RequestLabel = Context.Reference('mcpTracingTest/RequestLabel', { defaultValue: () => 'missing request' });
const config = {
  issuer: 'https://shell.test/oauth',
  prmUrl: 'https://shell.test/.well-known/oauth-protected-resource/mcp',
  publicOrigin: 'https://shell.test',
  resource: 'https://shell.test/mcp',
};
const protocolVersion = '2026-07-28';
const request = () =>
  new Request(config.resource, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: { name: 'tracing-test', version: '1.0.0' },
          [PROTOCOL_VERSION_META_KEY]: protocolVersion,
        },
        arguments: {},
        name: 'trace_request',
      },
    }),
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer good',
      'content-type': 'application/json',
      'mcp-method': 'tools/call',
      'mcp-name': 'trace_request',
      'mcp-protocol-version': protocolVersion,
    },
    method: 'POST',
  });

const tool: ToolSpec = {
  annotations: { readOnlyHint: true },
  description: 'Report the request service through the real SDK callback.',
  handler: () =>
    Effect.gen(function* tracedTool() {
      const label = yield* RequestLabel;
      yield* Effect.logInfo(label);
      return { content: [{ text: label, type: 'text' as const }] };
    }).pipe(Effect.withSpan('test.tool')),
  inputSchema: { type: 'object' },
  name: 'trace_request',
  title: 'Trace request',
};
const deps: McpEndpointDeps = {
  authenticate: () =>
    Effect.succeed({
      clientId: 'client',
      grantId: 'grant',
      kind: 'ok',
      tools: Effect.succeed({ kind: 'ok', tools: [tool] }),
    }),
  config: Effect.succeed(config),
};

const captureTracing = () => {
  const spans: { readonly parentStatus: string | undefined; readonly span: Tracer.Span }[] = [];
  const layer = Layer.succeed(
    Tracer.Tracer,
    Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const parent = Option.getOrUndefined(span.parent);
        spans.push({
          parentStatus: parent !== undefined && 'status' in parent ? parent.status._tag : undefined,
          span,
        });
        return span;
      },
    }),
  );
  return { layer, spans };
};

it.effect('runs each real-SDK tool under its own live Mcp.serve span and request services', () =>
  Effect.gen(function* requestScopedToolTracing() {
    const tracing = captureTracing();
    const serve = serveMcp(deps);
    for (const label of ['first request', 'second request']) {
      const start = tracing.spans.length;
      const response = yield* serve(request()).pipe(
        Effect.provideService(RequestLabel, label),
        Effect.provide(tracing.layer),
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        result: { content: [{ text: label, type: 'text' }] },
      });
      const spans = tracing.spans.slice(start);
      const serving = spans.find(({ span }) => span.name === 'Mcp.serve')?.span;
      const called = spans.find(({ span }) => span.name === 'test.tool');
      expect(serving).toBeDefined();
      expect(called).toBeDefined();
      expect(Option.getOrUndefined(called?.span.parent ?? Option.none())).toBe(serving);
      expect(called?.parentStatus).toBe('Started');
    }
  }),
);

it.effect('logs a real SDK protocol error with the live request span and request logger', () =>
  Effect.gen(function* requestScopedSdkErrorTracing() {
    const tracing = captureTracing();
    const logged = Promise.withResolvers<{
      readonly label: string;
      readonly parent: Tracer.AnySpan | undefined;
      readonly parentStatus: string | undefined;
    }>();
    const logger = Logger.layer([
      Logger.make((options) => {
        if (!JSON.stringify(options.message).includes('mcp handler error:')) {
          return;
        }
        const parent = Option.getOrUndefined(Context.getOption(options.fiber.context, Tracer.ParentSpan));
        logged.resolve({
          label: Context.get(options.fiber.context, RequestLabel),
          parent,
          parentStatus: parent !== undefined && 'status' in parent ? parent.status._tag : undefined,
        });
      }),
    ]);
    const invalid = request();
    invalid.headers.delete('mcp-method');
    const response = yield* serveMcp(deps)(invalid).pipe(
      Effect.provideService(RequestLabel, 'rejected request'),
      Effect.provide(Layer.merge(tracing.layer, logger)),
    );
    expect(response.status).toBe(400);
    expect(yield* Effect.promise(() => response.json())).toMatchObject({ error: { code: -32_020 } });
    const entry = yield* Effect.promise(() => logged.promise);
    const serving = tracing.spans.find(({ span }) => span.name === 'Mcp.serve')?.span;
    expect(serving).toBeDefined();
    expect(entry.label).toBe('rejected request');
    expect(entry.parent).toBe(serving);
    expect(entry.parentStatus).toBe('Started');
  }),
);
