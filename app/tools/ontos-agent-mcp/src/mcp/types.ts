/**
 * SDK-independent tool shapes of the OAuth resource server (lane mcp-mcp-rs). The tool layer (src/mcp/tools.ts)
 * produces ToolSpec[] per request; the server factory (src/mcp/server-factory.ts) registers them on an
 * @modelcontextprotocol/server v2 McpServer. Keep this file free of logic.
 */
import type { Catalog, JsonSchema } from '../capabilities/types.ts';
import type { ConnectionDescription, RsConfig, VerifiedAccessToken } from '../oauth/types.ts';
import type { PrincipalSession } from '../session.ts';

/** MCP tool annotations; only set the hints that matter. */
export interface ToolAnnotationsSpec {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface ToolTextContent {
  readonly type: 'text';
  readonly text: string;
}

/** A tool call result. Permission problems are `isError: true` results with Czech text, never HTTP errors. */
export interface ToolResult {
  readonly content: readonly ToolTextContent[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
  /** e.g. `{ 'mcp/www_authenticate': ['Bearer …'] }` when the grant stopped working mid-call. */
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export interface ToolSpec {
  /** e.g. `ontos_whoami`, `siampark_work__read_records`. */
  readonly name: string;
  /** Czech title. */
  readonly title: string;
  /** Czech description (generic tools: Czech + one English sentence). */
  readonly description: string;
  /** JSON Schema of the arguments; always `type: 'object'`. */
  readonly inputSchema: JsonSchema;
  readonly annotations: ToolAnnotationsSpec;
  /** Never throws: failures come back as `isError: true`. */
  readonly handler: (args: Readonly<Record<string, unknown>>) => Promise<ToolResult>;
}

/** Everything one request knows about its connection. */
export interface ConnectionContext {
  readonly description: ConnectionDescription;
  /** Undefined only outside HTTP (tests, stdio). */
  readonly token: VerifiedAccessToken | undefined;
  /** Principal used for gateway calls (`kind: 'oauth_connection'` over HTTP). */
  readonly session: PrincipalSession;
}

export interface ToolDeps {
  readonly config: RsConfig;
  readonly getCatalog: () => Promise<Catalog>;
  /** Injected in tests; defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
}
