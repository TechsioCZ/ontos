import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PrincipalSession } from './session.ts';

export interface CreateServerOptions {
  /** Register the legacy hand-written tools (whoami, list_*, create_task, propose_*); stdio only. */
  readonly legacyTools: boolean;
}

/**
 * Builds one MCP server for one principal session: generic capability tools (ontos_*) + typed tools for the
 * session's current company, filtered by the principal's grants. SKELETON: implemented by task "tools layer".
 */
export const createOntosMcpServer = async (
  _session: PrincipalSession,
  _options: CreateServerOptions,
): Promise<McpServer> => {
  throw new Error('createOntosMcpServer is not implemented yet');
};
