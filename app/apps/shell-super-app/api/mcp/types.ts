/** SDK-independent tool shapes of the Shell MCP endpoint. Keep this file free of logic. */
import { Data } from 'effect';
import type { Crypto, Effect } from 'effect';
import type {
  AgentProposalSubmitRequest,
  AgentProposalSubmitResponse,
  AgentQueueResponse,
} from '@app/shared-contracts/agent-proposals';
import type { ConnectionDescription } from '@app/shared-contracts/oauth-connections';

import type { JsonObject, McpCatalog } from './catalog.ts';

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
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly content: readonly ToolContent[];
  readonly isError?: boolean;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}

export interface ToolSpec {
  readonly annotations: ToolAnnotationsSpec;
  readonly description: string;
  /** Never fails: failures come back as `isError: true`. */
  readonly handler: (args: Readonly<Record<string, unknown>>) => Effect.Effect<ToolResult>;
  readonly inputSchema: JsonObject;
  readonly name: string;
  readonly outputSchema?: JsonObject;
  readonly title: string;
}

/** A module answer (any status); transport failures are `ModuleUnavailable`. */
export interface ModuleAnswer {
  readonly body: unknown;
  readonly status: number;
}

/** What the tools need from the Shell, all running as the connection's principal. */
export interface McpBackend {
  readonly callModule: (
    appId: string,
    path: string,
    body: unknown,
    options: { readonly idempotencyKey?: string; readonly referenceAudiences?: readonly string[] },
  ) => Effect.Effect<ModuleAnswer, ModuleUnavailable>;
  readonly listProposals: Effect.Effect<AgentQueueResponse, ModuleUnavailable>;
  readonly submitProposals: (
    request: AgentProposalSubmitRequest,
  ) => Effect.Effect<AgentProposalSubmitResponse, ModuleUnavailable | ProposalRefused>;
}

export interface McpToolContext {
  readonly backend: McpBackend;
  readonly catalog: McpCatalog;
  /** Idempotency keys, run ids and request hashes. */
  readonly crypto: Crypto.Crypto;
  readonly description: ConnectionDescription;
  /** `https://ontos-stage.example` (links shown to people). */
  readonly publicOrigin: string;
  /** Protected Resource Metadata URL (re-authentication challenge inside tool results). */
  readonly prmUrl: string;
}

/** The module could not be reached (composition, assertion or dispatch failed before it ran). */
export class ModuleUnavailable extends Data.TaggedError('ModuleUnavailable')<{ readonly message: string }> {}

/** A failed answer of a module, as an RFC 9457 problem. */
export class ModuleProblem extends Data.TaggedError('ModuleProblem')<{
  readonly code: string | undefined;
  readonly detail: string | undefined;
  readonly status: number;
  readonly title: string | undefined;
}> {
  override get message(): string {
    return `module answered HTTP ${this.status}${this.code === undefined ? '' : ` ${this.code}`}`;
  }
}

/** The platform approval queue refused the batch; `message` is Czech. */
export class ProposalRefused extends Data.TaggedError('ProposalRefused')<{ readonly message: string }> {}
