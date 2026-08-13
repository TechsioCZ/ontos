import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, rstest, test } from '@rstest/core';
import type { ReactNode } from 'react';
import { PageDeals } from '../../../../src/federation-entry.tsx';
import { DealsPage } from '../../../../src/routes/[lang]/deals/page.tsx';

const federatedI18nState = rstest.hoisted(() => ({
  resources: undefined as Record<string, Record<string, Record<string, string>>> | undefined,
  shellOnly: false,
}));

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({
    children,
    resources,
  }: {
    readonly children: ReactNode;
    readonly resources: Record<string, Record<string, Record<string, string>>>;
  }) => {
    federatedI18nState.resources = resources;
    return children;
  },
  useModernI18n: () => ({
    language: federatedI18nState.shellOnly ? 'cs' : 'en',
    t: (key: string) => {
      if (federatedI18nState.shellOnly) {
        return federatedI18nState.resources?.cs?.crm?.[key] ?? key;
      }
      return (
        {
          'crm.navigation.customers': 'Customers',
          'crm.navigation.deals': 'Deals',
          'crm.navigation.label': 'CRM sections',
          'crm.pages.deals.description': 'Deal workspace',
          'crm.pages.deals.empty': 'No deals',
          'crm.pages.deals.title': 'Deals',
        }[key] ?? key
      );
    },
  }),
}));

rstest.mock('../../../../src/routes/ultramodern-route-head.tsx', () => ({
  UltramodernRouteHead: () => null,
}));

afterEach(() => {
  federatedI18nState.resources = undefined;
  federatedI18nState.shellOnly = false;
  cleanup();
});

test('marks Deals current and links both embedded CRM sections', () => {
  render(<DealsPage target={{ writable: true }} />);
  expect(screen.getByRole('navigation', { name: 'CRM sections' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Customers' }).getAttribute('href')).toBe(
    '?page=crm.core.page.customers',
  );
  expect(screen.getByRole('link', { name: 'Deals' }).getAttribute('aria-current')).toBe('page');
  expect(screen.queryByRole('search')).toBeNull();
});

test('renders Czech Deals copy from the federated page entry hosted by the Shell runtime', () => {
  federatedI18nState.shellOnly = true;

  render(<PageDeals target={{ writable: true }} />);

  expect(screen.getByRole('heading', { name: 'Obchodní příležitosti' })).toBeTruthy();
  expect(screen.getByText('Správa obchodních příležitostí a jejich postupu.')).toBeTruthy();
  expect(screen.getByText('Zatím zde nejsou žádné obchodní příležitosti.')).toBeTruthy();
  expect(screen.queryByText('crm.pages.deals.title')).toBeNull();
});
