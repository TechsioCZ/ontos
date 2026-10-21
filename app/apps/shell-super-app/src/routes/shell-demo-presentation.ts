import { Schema } from 'effect';

import type { SafeTenantIdentity, ShellNavigationItem } from '../../shared/api.ts';
import { ShellNavigationItemSchema } from '../../shared/api.ts';

/** Legal entity of „Velkoobchod Hanák s.r.o.“, the wholesale CRM company (order imports, pairing, sales reports). */
const wholesaleCrmLegalEntityId = '71000000-0000-4000-8000-000000000022';
/** CRM pages that only make sense for the wholesale company; elsewhere CRM is the entrusted-contact register. */
const wholesaleOnlyCrmHrefs: ReadonlySet<string> = new Set(['/crm/importy', '/crm/parovani', '/crm/prehled-prodeju']);
/** Per-module AI approval pages replaced by the platform approval layer under Nastavení. */
const legacyAiApprovalHrefs: ReadonlySet<string> = new Set(['/crm/schvalovani-ai', '/prodej/schvalovani-ai']);

const agentPlatformItem = (
  href: string,
  label: string,
  order: number,
): ShellNavigationItem =>
  Schema.decodeUnknownSync(ShellNavigationItemSchema)({
    appId: 'shell-super-app',
    enabled: true,
    groupKey: 'settings',
    href,
    label,
    moduleId: 'shell-super-app',
    order,
    state: 'active',
    unavailable: false,
    writable: true,
  });

const agentApprovalsItem = agentPlatformItem('/sprava/ke-schvaleni', 'Ke schválení', 9000);
const agentActivityItem = agentPlatformItem('/sprava/aktivita-agentu', 'Aktivita agentů', 9001);

/** True when a module still exposes its own AI approval page, which the platform approval layer replaces. */
export const hasLegacyAiApprovals = (navigation: readonly ShellNavigationItem[]): boolean =>
  navigation.some(({ href }) => href !== undefined && legacyAiApprovalHrefs.has(href));

/**
 * Platform pages of the approval layer: shown to company administrators and to people who could open an old module
 * AI approval page.
 */
export const withAgentPlatformNavigation = (
  items: readonly ShellNavigationItem[],
  show: boolean,
): readonly ShellNavigationItem[] => (show ? [...items, agentApprovalsItem, agentActivityItem] : items);

/** Hide unfinished destinations; authority for people administration remains the server's governed list. */
export const presentableDemoNavigation = (
  navigation: readonly ShellNavigationItem[],
  canManagePeople: boolean,
  legalEntityId?: string,
): readonly ShellNavigationItem[] => {
  const wholesaleCrm = legalEntityId === undefined || legalEntityId === wholesaleCrmLegalEntityId;
  // In the wholesale company CRM owns the client workflow; the canonical registry is not yet integrated with its
  // snapshots. Elsewhere (Siampark) CRM is only the register of entrusted contacts, so the customer list stays.
  const hasCrmClients = navigation.some(
    ({ enabled, href, moduleId, unavailable }) =>
      moduleId === 'demo.crm' && href === '/crm/klienti' && enabled && !unavailable,
  );
  return navigation.filter(
    ({ href, moduleId }) =>
      href !== '/contacts' &&
      (href !== '/sprava/lide' || canManagePeople) &&
      (wholesaleCrm || moduleId !== 'demo.crm' || href === undefined || !wholesaleOnlyCrmHrefs.has(href)) &&
      (href === undefined || !legacyAiApprovalHrefs.has(href)) &&
      !(
        wholesaleCrm &&
        hasCrmClients &&
        moduleId === 'party.registry' &&
        (href === '/prodej/zakaznici' || href === '/zakaznici' || href === '/customers')
      ),
  );
};

const seededNames: Readonly<Record<string, { readonly original: string; readonly translated: string }>> = {
  'management@siampark.demo': { original: 'Management', translated: 'Vedení' },
  'operations@siampark.demo': { original: 'Operations', translated: 'Provoz' },
  'finance@siampark.demo': { original: 'Finance', translated: 'Účetní' },
  'external@siampark.demo': { original: 'External Agent', translated: 'Externí obchodník' },
};

/** Translate only known English fixtures, never overwrite an administrator's chosen personal name. */
export const demoDisplayName = ({ displayName, email }: Pick<SafeTenantIdentity, 'displayName' | 'email'>): string => {
  const seeded = seededNames[email];
  return seeded?.original === displayName ? seeded.translated : displayName;
};
