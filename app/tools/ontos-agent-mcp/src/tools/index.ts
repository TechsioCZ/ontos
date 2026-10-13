import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBillingTools } from './billing.ts';
import { registerCustomerTools } from './customers.ts';
import { registerMerchandiseTools } from './merchandise.ts';
import { registerMetricTools } from './metrics.ts';
import { registerSalesTools } from './sales.ts';
import { registerTaggingTools } from './tagging.ts';
import { registerWorkTools } from './work.ts';
import { registerWorkforceTools } from './workforce.ts';

/**
 * Registers the sales-agent domain tools: reads (list_*, get_metrics) and governed writes (create/update/assign).
 * Called once from src/server.ts after the core tools. Do not write to stdout from tool code: stdout is the
 * MCP stdio channel. Use console.error for diagnostics.
 */
export function registerDomainTools(server: McpServer): void {
  registerCustomerTools(server);
  registerWorkforceTools(server);
  registerSalesTools(server);
  registerMerchandiseTools(server);
  registerBillingTools(server);
  registerWorkTools(server);
  registerTaggingTools(server);
  registerMetricTools(server);
}
