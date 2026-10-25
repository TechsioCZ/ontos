/** SDK-independent tool shapes of the Shell MCP endpoint. Keep this file free of logic. */
import type { Crypto, Effect, Schema } from 'effect';
import type {
  AgentProposalSubmitRequest,
  AgentProposalSubmitResponse,
  AgentQueueResponse,
} from '@app/shared-contracts/agent-proposals';
import type { ConnectionDescription } from '@app/shared-contracts/oauth-connections';

import type { JsonObject, McpCatalog } from './catalog.ts';
import type { ModuleUnavailable } from './module-unavailable.ts';
import type { ProposalRefused } from './proposal-refused.ts';

export interface ToolAnnotationsSpec {
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
  readonly readOnlyHint?: boolean;
}

export interface ToolTextContent {
  readonly text: string;
  readonly type: 'text';
}

/** Link into the OntOS UI (review queue, module page). */
export interface ToolResourceLinkContent {
  readonly description?: string;
  readonly mimeType?: string;
  readonly name: string;
  readonly title?: string;
  readonly type: 'resource_link';
  readonly uri: string;
}

export type ToolContent = ToolResourceLinkContent | ToolTextContent;

/** Permission problems are `isError: true` results with Czech text, never HTTP errors. */
export interface ToolResult {
  readonly _meta?: Schema.JsonObject;
  readonly content: readonly ToolContent[];
  readonly isError?: boolean;
  readonly structuredContent?: Schema.JsonObject;
}

export interface ToolSpec {
  readonly annotations: ToolAnnotationsSpec;
  readonly description: string;
  /** Expected failures become `isError` results; defects remain owned by the outer SDK/HTTP boundary. */
  readonly handler: (args: Schema.JsonObject) => Effect.Effect<ToolResult>;
  readonly inputSchema: JsonObject;
  readonly name: string;
  readonly outputSchema?: JsonObject;
  readonly title: string;
}

/** A module answer (any status); transport failures are `ModuleUnavailable`. */
export interface ModuleAnswer {
  readonly body: Schema.Json;
  readonly status: number;
}

/** What the tools need from the Shell, all running as the connection's principal. */
export interface McpBackend {
  readonly callModule: (
    appId: string,
    path: string,
    body: Schema.Json,
    options: { readonly idempotencyKey?: string; readonly referenceAudiences?: readonly string[] },
  ) => Effect.Effect<ModuleAnswer, ModuleUnavailable>;
  readonly listProposals: Effect.Effect<AgentQueueResponse, ModuleUnavailable>;
  readonly submitProposals: (
    request: AgentProposalSubmitRequest,
    intent: { readonly idempotencyKey: string },
  ) => Effect.Effect<AgentProposalSubmitResponse, ModuleUnavailable | ProposalRefused>;
}

export interface McpToolContext {
  readonly backend: McpBackend;
  readonly catalog: McpCatalog;
  /** Request hashes; mutation intent and optional run ids come only from tool arguments. */
  readonly crypto: Crypto.Crypto;
  readonly description: ConnectionDescription;
  /** Protected Resource Metadata URL (re-authentication challenge inside tool results). */
  readonly prmUrl: string;
  /** `https://ontos-stage.example` (links shown to people). */
  readonly publicOrigin: string;
}
