import { afterEach, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import csCatalog from '../../locales/cs/projects.json';
import enCatalog from '../../locales/en/projects.json';
import { ProjectsPage } from '../../src/routes/[lang]/projects/page.tsx';

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
      if (key === 'projects.pages.projects.customers') {
        return catalogs[localeState.current].projects.pages.projects.customers;
      }
      if (key === 'projects.pages.projects.title') {
        return catalogs[localeState.current].projects.pages.projects.title;
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
    href: '/cs/projects/customers',
    language: 'cs' as const,
    title: 'Projekty',
  },
  {
    customers: 'Customers',
    href: '/en/projects/customers',
    language: 'en' as const,
    title: 'Projects',
  },
])(
  'renders the localized Projects landing page for $language',
  ({ customers, href, language, title }) => {
    localeState.current = language;
    render(<ProjectsPage />);

    expect(screen.getByRole('heading', { level: 1, name: title })).toBeTruthy();
    expect(screen.getByRole('link', { name: customers }).getAttribute('href')).toBe(href);
  },
);
