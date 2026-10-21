import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentCompany, AgentProfile } from './config.ts';

/**
 * Tools registered per AI agent level and company (specs AGENT.md). This is the convenience layer only: the real
 * boundary is the backend grant of the profile's principal (scripts/demo/ai-profiles.mts). A level-A key cannot
 * write even when a client calls the vertical API directly; Core answers 403 and records a denied audit event.
 *
 * Every listed read tool works with the company's grants: a company only lists reads of modules it actually has
 * (Hanák has CRM, workforce, tasks and tags; no pipeline, catalogue, orders module or invoices).
 */
const OBCHOD_READ_TOOLS = [
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
const HANAK_READ_TOOLS = ['whoami', 'list_crm', 'list_customers', 'list_employees', 'list_tasks', 'list_tags'] as const;
const TASK_WRITE_TOOLS = ['create_task', 'update_task'] as const;

export const COMPANY_PROFILE_TOOLS = {
  hanak: {
    A: new Set<string>(HANAK_READ_TOOLS),
    B: new Set<string>([...HANAK_READ_TOOLS, ...TASK_WRITE_TOOLS]),
    C: new Set<string>(['whoami', 'list_crm', 'propose_crm_changes']),
  },
  obchod: {
    A: new Set<string>(OBCHOD_READ_TOOLS),
    B: new Set<string>([...OBCHOD_READ_TOOLS, ...TASK_WRITE_TOOLS]),
    // Level C reads what it needs to propose, then proposes; it has no direct write tool and no write grant.
    C: new Set<string>([
      'whoami',
      'list_customers',
      'list_employees',
      'list_opportunities',
      'list_orders',
      'list_products',
      'list_ai_proposals',
      'propose_sales_changes',
    ]),
  },
} as const satisfies Record<AgentCompany, Record<AgentProfile, ReadonlySet<string>>>;

/** Tools of one level in the default company of that level (C: Hanák, A/B: Obchodní firma). */
export const PROFILE_TOOLS = {
  A: COMPANY_PROFILE_TOOLS.obchod.A,
  B: COMPANY_PROFILE_TOOLS.obchod.B,
  C: COMPANY_PROFILE_TOOLS.hanak.C,
} as const satisfies Record<AgentProfile, ReadonlySet<string>>;

export const profileTools = (profile: AgentProfile, company: AgentCompany | undefined): ReadonlySet<string> =>
  company === undefined ? PROFILE_TOOLS[profile] : COMPANY_PROFILE_TOOLS[company][profile];

export const PROFILE_LABEL = {
  C: 'Úroveň C — návrhy změn; každý zápis schvaluje člověk v aplikaci a dávku lze vrátit',
  A: 'Úroveň A — jen čtení (objednávky, příležitosti, úkoly, zaměstnanci)',
  B: 'Úroveň B — čtení + vytváření a úprava úkolů (zápis jen do sekce Úkoly)',
} as const satisfies Record<AgentProfile, string>;

export const profileLabel = (profile: AgentProfile, company: AgentCompany | undefined): string =>
  profile !== 'C'
    ? PROFILE_LABEL[profile]
    : company === 'obchod'
      ? 'Úroveň C — návrhy změn příležitostí a objednávek; každou změnu schvaluje člověk na /prodej/schvalovani-ai'
      : 'Úroveň C — návrhy změn CRM; každou změnu schvaluje člověk na /crm/schvalovani-ai';

export const isToolAllowed = (
  profile: AgentProfile | undefined,
  name: string,
  company?: AgentCompany | undefined,
): boolean => profile === undefined || profileTools(profile, company).has(name);

/**
 * Returns a view of `server` whose `registerTool` silently skips tools outside the profile, so tool modules stay
 * unchanged. Without a profile every tool is registered (legacy `agent-bot`).
 */
export const restrictToProfile = (
  server: McpServer,
  profile: AgentProfile | undefined,
  company?: AgentCompany | undefined,
): McpServer => {
  if (profile === undefined) {
    return server;
  }
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== 'registerTool') {
        return Reflect.get(target, property, receiver);
      }
      const register: McpServer['registerTool'] = (name, config, callback) =>
        isToolAllowed(profile, name, company)
          ? target.registerTool(name, config, callback)
          : // A skipped tool is never listed; the stub keeps the return type for callers that ignore it.
            ({ remove: () => undefined } as unknown as ReturnType<McpServer['registerTool']>);
      return register;
    },
  });
};
