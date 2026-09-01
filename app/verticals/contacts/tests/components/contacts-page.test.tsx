import { afterEach, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
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
      if (key === 'contacts.pages.contacts.customers') {
        return catalogs[localeState.current].contacts.pages.contacts.customers;
      }
      if (key === 'contacts.pages.contacts.title') {
        return catalogs[localeState.current].contacts.pages.contacts.title;
      }
      return key;
    },
  }),
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a {...props} href={to}>
      {children}
    </a>
  ),
}));

rstest.mock('../../src/routes/ultramodern-route-head.tsx', () => ({
  UltramodernRouteHead: () => null,
}));

afterEach(() => {
  cleanup();
  localeState.current = 'en';
});

test.each([
  {
    customers: 'Zákazníci',
    href: '/cs/contacts/customers',
    language: 'cs' as const,
    title: 'Kontakty',
  },
  {
    customers: 'Customers',
    href: '/en/contacts/customers',
    language: 'en' as const,
    title: 'Contacts',
  },
])(
  'renders the localized Contacts landing page for $language',
  ({ customers, href, language, title }) => {
    localeState.current = language;
    render(<ContactsPage />);

    expect(screen.getByRole('heading', { level: 1, name: title })).toBeTruthy();
    expect(screen.getByRole('link', { name: customers }).getAttribute('href')).toBe(href);
  },
);
