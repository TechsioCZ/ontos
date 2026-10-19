import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentProfile } from './config.ts';

/**
 * Tools registered per AI agent level (specs AGENT.md). This is the convenience layer only: the real boundary is
 * the backend grant of the profile's principal (scripts/demo/ai-profiles.mts). A level-A key cannot write even when
 * a client calls the vertical API directly; Core answers 403 and records a denied audit event.
 */
const READ_TOOLS = [
  'whoami',
  'list_customers',
  'list_employees',
  'list_opportunities',
  'list_orders',
  'list_products',
  'list_invoices',
  'list_tasks',
  'list_tags',
  'list_metrics',
  'get_metrics',
] as const;

export const PROFILE_TOOLS = {
  A: new Set<string>(READ_TOOLS),
  B: new Set<string>([...READ_TOOLS, 'create_task', 'update_task']),
} as const satisfies Record<AgentProfile, ReadonlySet<string>>;

export const PROFILE_LABEL = {
  A: 'Úroveň A — jen čtení (objednávky, příležitosti, úkoly, zaměstnanci)',
  B: 'Úroveň B — čtení + vytváření a úprava úkolů (zápis jen do sekce Úkoly)',
} as const satisfies Record<AgentProfile, string>;

export const isToolAllowed = (profile: AgentProfile | undefined, name: string): boolean =>
  profile === undefined || PROFILE_TOOLS[profile].has(name);

/**
 * Returns a view of `server` whose `registerTool` silently skips tools outside the profile, so tool modules stay
 * unchanged. Without a profile every tool is registered (legacy `agent-bot`).
 */
export const restrictToProfile = (server: McpServer, profile: AgentProfile | undefined): McpServer => {
  if (profile === undefined) {
    return server;
  }
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== 'registerTool') {
        return Reflect.get(target, property, receiver);
      }
      const register: McpServer['registerTool'] = (name, config, callback) =>
        isToolAllowed(profile, name)
          ? target.registerTool(name, config, callback)
          : // A skipped tool is never listed; the stub keeps the return type for callers that ignore it.
            ({ remove: () => undefined } as unknown as ReturnType<McpServer['registerTool']>);
      return register;
    },
  });
};
