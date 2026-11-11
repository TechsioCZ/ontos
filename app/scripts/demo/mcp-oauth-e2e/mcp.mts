import { Client, isSpecType, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Array as EffectArray, Duration, Effect, Option, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { proofToolCall } from './tool-call.mts';

export const MODERN_PROTOCOL_VERSION = '2026-07-28';
export const LEGACY_PROTOCOL_VERSION = '2025-11-25';

class McpTransportFailure extends Schema.TaggedError<McpTransportFailure>()('McpTransportFailure', {
  cause: Schema.Defect(),
}) {}

/** One authenticated MCP request of a proof client: its method and the time until the SDK had its answer. */
export interface McpRequestTiming {
  readonly method: string;
  readonly ms: number;
}

const DISCOVER = 'server/discover';
const LIST_TOOLS = 'tools/list';
const CALL_TOOL = 'tools/call';

/** Longest acceptable time of one authenticated request, by MCP method. */
const MCP_LATENCY_BUDGET_MS = new Map([
  [DISCOVER, 3000],
  [CALL_TOOL, 10_000],
  [LIST_TOOLS, 3000],
]);

/** The requests over their budget, as `method ms` lines (empty when every request is within it). */
export const overBudget = (timings: readonly McpRequestTiming[]): readonly string[] =>
  timings.flatMap(({ method, ms }) => {
    const budget = MCP_LATENCY_BUDGET_MS.get(method);
    return budget !== undefined && ms > budget ? [`${method} ${ms} ms > ${budget} ms`] : [];
  });

/** The slowest request of each method, as `method max ms (count)`. */
export const latencySummary = (timings: readonly McpRequestTiming[]): string =>
  [...Map.groupBy(timings, ({ method }) => method)]
    .map(([method, entries]) => `${method} max ${Math.max(...entries.map(({ ms }) => ms))} ms (${entries.length}×)`)
    .join(', ');

/** Every timed request of each proof client, in the order it was sent. */
const clientTimings = new WeakMap<Client, McpRequestTiming[]>();

/** The requests this client has sent so far (connect = `server/discover`, list, calls). */
export const timingsOf = (client: Client): readonly McpRequestTiming[] => clientTimings.get(client) ?? [];

/** Runs one request of `client` and records how long it took. */
const timedRequest = <A, E, R>(client: Client, method: string, request: Effect.Effect<A, E, R>) =>
  Effect.timed(request).pipe(
    Effect.map(([elapsed, value]) => {
      const timings = clientTimings.get(client) ?? [];
      timings.push({ method, ms: Math.round(Duration.toMillis(elapsed)) });
      clientTimings.set(client, timings);
      return value;
    }),
  );

/** The server speaks the current MCP revision only, so every client pins it. Its requests are timed. */
export const connectMcp = (serverUrl: string, accessToken: Redacted.Redacted) =>
  Effect.gen(function* connectClient() {
    const client = new Client(
      { name: 'ontos-oauth-e2e', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } },
    );
    // A pinned 2026-07-28 client connects with exactly one `server/discover`.
    yield* timedRequest(
      client,
      DISCOVER,
      Effect.tryPromise({
        catch: (cause) => new McpTransportFailure({ cause }),
        try: async () =>
          await client.connect(
            new StreamableHTTPClientTransport(new URL(serverUrl), {
              requestInit: { headers: { authorization: `Bearer ${Redacted.value(accessToken)}` } },
            }),
          ),
      }),
    ).pipe(
      Effect.onError(() =>
        Effect.tryPromise({
          catch: (cause) => new McpTransportFailure({ cause }),
          try: async () => await client.close(),
        }).pipe(Effect.ignore),
      ),
    );
    const protocolVersion = client.getNegotiatedProtocolVersion();
    return { client, protocolVersion };
  });

/** The client's tools (`tools/list`), timed. */
export const listTools = (client: Client) =>
  timedRequest(
    client,
    LIST_TOOLS,
    Effect.tryPromise(async () => await client.listTools()),
  );

/** Closes the foreign MCP client in its caller's fiber. */
export const closeMcpClient = (client: Client) => Effect.tryPromise(async () => await client.close());

export interface ToolOutcome {
  readonly isError: boolean;
  readonly text: string;
  readonly value: Schema.Json;
}

type ToolArguments = NonNullable<Parameters<Client['callTool']>[0]['arguments']>;

// The SDK owns the rest of the reply; SEP-2106 permits any JSON value in this optional member.
const McpToolReplyProjectionSchema = Schema.Struct({ structuredContent: Schema.optional(Schema.Json) });

export const callJson = (client: Client, name: string, args: ToolArguments = {}) =>
  Effect.gen(function* callMcpJson() {
    const result = yield* proofToolCall(
      name,
      args,
      timedRequest(
        client,
        CALL_TOOL,
        Effect.tryPromise(async () => await client.callTool({ arguments: args, name })),
      ),
    );
    const content = EffectArray.isArray(result.content) ? result.content : [];
    const text = content
      .filter(isSpecType.TextContent)
      .map((item) => item.text)
      .join('\n');
    const isError = result.isError === true;
    const reply = yield* Schema.decodeUnknownEffect(McpToolReplyProjectionSchema)(result);
    const value =
      reply.structuredContent === undefined
        ? Option.getOrElse(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(text), () => text)
        : reply.structuredContent;
    const outcome: ToolOutcome = { isError, text, value };
    return outcome;
  });

const ToolListSchema = Schema.Struct({
  id: Schema.Literal(1),
  jsonrpc: Schema.Literal('2.0'),
  method: Schema.Literal(LIST_TOOLS),
  params: Schema.Struct({}),
});

/** Plain HTTP (no SDK, no caching) so 401 challenges and WWW-Authenticate headers can be checked. */
export const rawMcpStatus = (serverUrl: string, accessToken: Option.Option<Redacted.Redacted>) =>
  Effect.gen(function* mcpStatus() {
    const http = HttpClient.withScope(yield* HttpClient.HttpClient);
    let request = HttpClientRequest.post(serverUrl).pipe(
      HttpClientRequest.setHeader('accept', 'application/json, text/event-stream'),
    );
    if (Option.isSome(accessToken)) {
      request = HttpClientRequest.setHeader(request, 'authorization', `Bearer ${Redacted.value(accessToken.value)}`);
    }
    const encoded = yield* HttpClientRequest.schemaBodyJson(ToolListSchema)(request, {
      id: 1,
      jsonrpc: '2.0',
      method: LIST_TOOLS,
      params: {},
    });
    const response = yield* http.execute(encoded);
    return { status: response.status, wwwAuthenticate: Option.fromUndefinedOr(response.headers['www-authenticate']) };
  }).pipe(Effect.scoped);

const LegacyInitializeSchema = Schema.Struct({
  id: Schema.Literal(1),
  jsonrpc: Schema.Literal('2.0'),
  method: Schema.Literal('initialize'),
  params: Schema.Struct({
    capabilities: Schema.Struct({}),
    clientInfo: Schema.Struct({ name: Schema.Literal('ontos-oauth-e2e-legacy'), version: Schema.Literal('1.0.0') }),
    protocolVersion: Schema.Literal(LEGACY_PROTOCOL_VERSION),
  }),
});

/** A 2025-era `initialize`; a current-only server answers with an error naming the revision it supports. */
export const rawLegacyInitialize = (serverUrl: string, accessToken: Redacted.Redacted) =>
  Effect.gen(function* legacyInitialize() {
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(LegacyInitializeSchema))({
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        capabilities: {},
        clientInfo: { name: 'ontos-oauth-e2e-legacy', version: '1.0.0' },
        protocolVersion: LEGACY_PROTOCOL_VERSION,
      },
    });
    const http = HttpClient.withScope(yield* HttpClient.HttpClient);
    const request = HttpClientRequest.post(serverUrl).pipe(
      HttpClientRequest.setHeaders({
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${Redacted.value(accessToken)}`,
        'content-type': 'application/json',
      }),
      HttpClientRequest.bodyText(body, 'application/json'),
    );
    const response = yield* http.execute(request);
    return { body: yield* response.text, status: response.status };
  }).pipe(Effect.scoped);
