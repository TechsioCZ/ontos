import { afterEach, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import csCatalog from '../../locales/cs/crm.json';
import enCatalog from '../../locales/en/crm.json';
import { CrmPage } from '../../src/routes/[lang]/crm/page.tsx';

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
      if (key === 'crm.pages.crm.customers') {
        return catalogs[localeState.current].crm.pages.crm.customers;
      }
      if (key === 'crm.pages.crm.title') {
        return catalogs[localeState.current].crm.pages.crm.title;
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
  { customers: 'Zákazníci', href: '/cs/crm/customers', language: 'cs' as const },
  { customers: 'Customers', href: '/en/crm/customers', language: 'en' as const },
])('renders the localized CRM landing page for $language', ({ customers, href, language }) => {
  localeState.current = language;
  render(<CrmPage />);

  expect(screen.getByRole('heading', { level: 1, name: 'CRM' })).toBeTruthy();
  expect(screen.getByRole('link', { name: customers }).getAttribute('href')).toBe(href);
});
