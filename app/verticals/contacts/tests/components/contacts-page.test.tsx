import { afterEach, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen } from '@testing-library/react';
import csCatalog from '../../locales/cs/contacts.json';
import enCatalog from '../../locales/en/contacts.json';
import { ContactsPage } from '../../src/routes/[lang]/contacts/page.tsx';

interface LocaleState {
  current: 'cs' | 'en';
}

const { localeState } = rstest.hoisted(() => {
  const state: LocaleState = { current: 'en' };
  return { localeState: state };
});

const catalogs = { cs: csCatalog, en: enCatalog } as const;

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    language: localeState.current,
    t: (key: string) => {
      if (key === 'contacts.pages.contacts.description') {
        return catalogs[localeState.current].contacts.pages.contacts.description;
      }
      if (key === 'contacts.pages.contacts.title') {
        return catalogs[localeState.current].contacts.pages.contacts.title;
      }
      return key;
    },
  }),
}));

rstest.mock('../../src/routes/ultramodern-route-head.tsx', () => ({
  UltramodernRouteHead: () => null,
}));

afterEach(() => {
  cleanup();
  localeState.current = 'en';
});

test.each([
  { language: 'cs' as const, title: 'Kontakty' },
  { language: 'en' as const, title: 'Contacts' },
])('presents the localized engagement profile boundary for $language', ({ language, title }) => {
  localeState.current = language;
  render(<ContactsPage />);

  expect(screen.getByRole('heading', { level: 1, name: title })).toBeTruthy();
  expect(screen.getByText(catalogs[language].contacts.pages.contacts.description)).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
});
