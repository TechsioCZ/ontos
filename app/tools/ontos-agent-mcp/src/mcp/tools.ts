/**
 * Connection tools (lane mcp-mcp-rs). SKELETON: task "tool layer" replaces the body; the signature is fixed so the
 * HTTP task can import it in parallel.
 */
import type { ConnectionContext, ToolDeps, ToolSpec } from './types.ts';

/** Tools of one request: generic ontos_* tools plus typed tools, filtered by the connection description. */
export const buildConnectionTools = async (
  _connection: ConnectionContext,
  _deps: ToolDeps,
): Promise<readonly ToolSpec[]> => {
  throw new Error('buildConnectionTools is not implemented yet (lane mcp-mcp-rs, tool layer task)');
};
