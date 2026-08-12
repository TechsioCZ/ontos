import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, rstest, test } from '@rstest/core';
import { DealsPage } from '../../../../src/routes/[lang]/deals/page.tsx';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    language: 'en',
    t: (key: string) =>
      ({
        'crm.navigation.customers': 'Customers',
        'crm.navigation.deals': 'Deals',
        'crm.navigation.label': 'CRM sections',
        'crm.pages.deals.description': 'Deal workspace',
        'crm.pages.deals.empty': 'No deals',
        'crm.pages.deals.title': 'Deals',
      })[key] ?? key,
  }),
}));

rstest.mock('../../../../src/routes/ultramodern-route-head.tsx', () => ({
  UltramodernRouteHead: () => null,
}));

afterEach(cleanup);

test('marks Deals current and links both embedded CRM sections', () => {
  render(<DealsPage target={{ writable: true }} />);
  expect(screen.getByRole('navigation', { name: 'CRM sections' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Customers' }).getAttribute('href')).toBe(
    '/modules/crm.core?page=crm.core.page.customers',
  );
  expect(screen.getByRole('link', { name: 'Deals' }).getAttribute('aria-current')).toBe('page');
  expect(screen.queryByRole('search')).toBeNull();
});
