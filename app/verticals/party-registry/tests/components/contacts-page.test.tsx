import { FederatedI18nBoundary } from '@modern-js/i18n-integration/federation';
import { ModernI18nProvider } from '@modern-js/plugin-i18n/runtime/consumer';
import { RuntimeComponentResolverContext } from '@modern-js/runtime/context';
import head from '@modern-js/runtime/head';
import { cleanup, render, screen } from '@testing-library/react';
import { assertI18nInstance } from '@modern-js/plugin-i18n/i18n';
import { createInstance } from 'i18next';
import { afterEach, expect, test } from 'effect-rstest';
import type { ContextType } from 'react';

import csCatalog from '../../locales/cs/party-registry.json';
import enCatalog from '../../locales/en/party-registry.json';
import ContactsPage from '../../src/routes/[lang]/contacts/page.tsx';

const catalogs = { cs: csCatalog, en: enCatalog } as const;
// The runtime head provider the Modern root mounts above every route.
const { HelmetProvider } = head;

// The same resolution the i18n-integration runtime plugin registers: the page's federated boundary
// becomes the actual integration boundary, every other runtime component stays itself.
const resolveRuntimeComponent: NonNullable<ContextType<typeof RuntimeComponentResolverContext>> = (
  component,
  { name },
) => (name === 'i18n.FederatedI18nBoundary' ? FederatedI18nBoundary : component);

// A host i18next instance with no Party Registry resources: every rendered string must come from
// the resources the page's own boundary installs.
const makeHostI18n = (language: 'cs' | 'en') => {
  const instance = createInstance();
  void instance.init({ fallbackLng: 'en', initAsync: false, lng: language, resources: {} });
  assertI18nInstance(instance);
  return instance;
};

afterEach(cleanup);

test.each([
  { language: 'cs' as const, title: 'Kontakty' },
  { language: 'en' as const, title: 'Contacts' },
])('presents the localized engagement profile boundary for $language', ({ language, title }) => {
  const host = makeHostI18n(language);
  render(
    <HelmetProvider>
      <RuntimeComponentResolverContext.Provider value={resolveRuntimeComponent}>
        <ModernI18nProvider value={{ i18nInstance: host, language, languages: ['en', 'cs'] }}>
          <ContactsPage />
        </ModernI18nProvider>
      </RuntimeComponentResolverContext.Provider>
    </HelmetProvider>,
  );

  expect(screen.getByRole('heading', { level: 1, name: title })).toBeTruthy();
  expect(screen.getByText(catalogs[language]['party-registry'].pages.contacts.description)).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
});
