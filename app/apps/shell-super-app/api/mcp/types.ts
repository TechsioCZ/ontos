/** SDK-independent tool shapes of the Shell MCP endpoint. Keep this file free of logic. */
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
  /** Never throws: failures come back as `isError: true`. */
  readonly handler: (args: Readonly<Record<string, unknown>>) => Promise<ToolResult>;
  readonly inputSchema: JsonObject;
  readonly name: string;
  readonly outputSchema?: JsonObject;
  readonly title: string;
}

/** A module answer (any status); transport failures throw `ModuleUnavailable`. */
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
  ) => Promise<ModuleAnswer>;
  readonly listProposals: () => Promise<AgentQueueResponse>;
  readonly submitProposals: (request: AgentProposalSubmitRequest) => Promise<AgentProposalSubmitResponse>;
}

export interface McpToolContext {
  readonly backend: McpBackend;
  readonly catalog: McpCatalog;
  readonly description: ConnectionDescription;
  /** `https://ontos-stage.example` (links shown to people). */
  readonly publicOrigin: string;
  /** Protected Resource Metadata URL (re-authentication challenge inside tool results). */
  readonly prmUrl: string;
}

/** The module could not be reached (composition, assertion or dispatch failed before it ran). */
export class ModuleUnavailable extends Error {
  override readonly name = 'ModuleUnavailable';
}

/** A failed answer of a module, as an RFC 9457 problem. */
export class ModuleProblem extends Error {
  override readonly name = 'ModuleProblem';
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly detail: string | undefined,
    readonly title: string | undefined,
  ) {
    super(`module answered HTTP ${status}${code === undefined ? '' : ` ${code}`}`);
  }
}

/** The platform approval queue refused the batch; `message` is Czech. */
export class ProposalRefused extends Error {
  override readonly name = 'ProposalRefused';
}
