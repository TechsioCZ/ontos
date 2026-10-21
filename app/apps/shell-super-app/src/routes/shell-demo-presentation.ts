import type { SafeTenantIdentity, ShellNavigationItem } from '../../shared/api.ts';

/** Legal entity of „Velkoobchod Hanák s.r.o.“, the wholesale CRM company (order imports, pairing, sales reports). */
const wholesaleCrmLegalEntityId = '71000000-0000-4000-8000-000000000022';
/** Legal entity of „Obchodní firma“, the only company with an opportunity/order AI agent of level C. */
const commercialLegalEntityId = '71000000-0000-4000-8000-000000000020';
/** CRM pages that only make sense for the wholesale company; elsewhere CRM is the entrusted-contact register. */
const wholesaleOnlyCrmHrefs: ReadonlySet<string> = new Set([
  '/crm/importy',
  '/crm/parovani',
  '/crm/prehled-prodeju',
  '/crm/schvalovani-ai',
]);

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
      (href !== '/prodej/schvalovani-ai' || legalEntityId === undefined || legalEntityId === commercialLegalEntityId) &&
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
