import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * DOMAIN TOOL HOOK. Later tasks register sales tools here.
 *
 * Called once from src/server.ts after the core tools are registered. Do not write to stdout from
 * tool code: stdout is the MCP stdio channel. Use console.error for diagnostics.
 */
export function registerDomainTools(_server: McpServer): void {
  // Intentionally empty for the scaffold.
}
