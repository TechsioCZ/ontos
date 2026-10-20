import type { SafeTenantIdentity, ShellNavigationItem } from '../../shared/api.ts';

/** Hide unfinished destinations; authority for people administration remains the server's governed list. */
export const presentableDemoNavigation = (
  navigation: readonly ShellNavigationItem[],
  canManagePeople: boolean,
): readonly ShellNavigationItem[] => {
  // CRM owns this company's client workflow; the canonical registry is not yet integrated with its snapshots.
  const hasCrmClients = navigation.some(
    ({ enabled, href, moduleId, unavailable }) =>
      moduleId === 'demo.crm' && href === '/crm/klienti' && enabled && !unavailable,
  );
  return navigation.filter(
    ({ href, moduleId }) =>
      href !== '/contacts' &&
      (href !== '/sprava/lide' || canManagePeople) &&
      !(
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
