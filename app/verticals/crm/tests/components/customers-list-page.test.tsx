// @effect-diagnostics asyncFunction:off anyUnknownInErrorContext:off globalDate:off nodeBuiltinImport:off
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect } from 'effect';
import type { ReactNode } from 'react';
import csCatalog from '../../locales/cs/crm.json';
import enCatalog from '../../locales/en/crm.json';
import { flattenCatalogKeys } from '../support/locale-catalog.ts';
import {
  CUSTOMER_LIST_PAGE_SIZE,
  CustomersListPage,
  buildCustomerListHref,
  classifyCustomerListError,
  customerListQueryKey,
  parseCustomerListSearch,
} from '../../src/routes/[lang]/crm/customers/page.tsx';

interface LocaleState {
  current: 'cs' | 'en';
}

Object.assign(globalThis, {
  ULTRAMODERN_CRM_API_BASE_URL: 'http://localhost:4101/crm-api',
});

const {
  archiveCustomerMock,
  getCustomerListMock,
  localeState,
  navigateMock,
  runEffectRequestMock,
  searchState,
  unarchiveCustomerMock,
} = rstest.hoisted(() => {
  const state: LocaleState = { current: 'en' };
  return {
    archiveCustomerMock: rstest.fn(),
    getCustomerListMock: rstest.fn(),
    localeState: state,
    navigateMock: rstest.fn(() => Promise.resolve()),
    runEffectRequestMock: rstest.fn(),
    searchState: { current: '' },
    unarchiveCustomerMock: rstest.fn(),
  };
});

const requireRow = (rows: readonly HTMLElement[], index: number): HTMLElement => {
  const row = rows[index];
  if (row === undefined) {
    throw new Error(`Expected table row ${index}`);
  }
  return row;
};

const translations = {
  cs: {
    'crm.pages.customerCreate.title': 'Vytvořit zákazníka',
    'crm.pages.customerEdit.title': 'Upravit zákazníka',
    'crm.pages.customersList.filter.active': 'Aktivní',
    'crm.pages.customersList.filter.all': 'Všichni',
    'crm.pages.customersList.filter.archived': 'Archivovaní',
    'crm.pages.customersList.filter.label': 'Stav zákazníka',
    'crm.pages.customersList.filter.placeholder': 'Vyberte stav',
    'crm.pages.customersList.lifecycle.authenticationExpired': 'Relace vypršela.',
    'crm.pages.customersList.lifecycle.conflict': 'Stav se změnil.',
    'crm.pages.customersList.lifecycle.forbidden': 'Změna není povolena.',
    'crm.pages.customersList.lifecycle.invalid': 'Požadavek není platný.',
    'crm.pages.customersList.lifecycle.notFound': 'Zákazník nebyl nalezen.',
    'crm.pages.customersList.lifecycle.unavailable': 'Změna není dostupná.',
    'crm.pages.customersList.lifecycle.unexpected': 'Změna se nezdařila.',
    'crm.pages.customersList.pagination.label': 'Stránky seznamu zákazníků',
    'crm.pages.customersList.pagination.next': 'Další',
    'crm.pages.customersList.pagination.previous': 'Předchozí',
    'crm.pages.customersList.states.authenticationExpired':
      'Vaše relace vypršela. Po přihlášení to zkuste znovu.',
    'crm.pages.customersList.states.decode':
      'Odpověď se seznamem zákazníků se nepodařilo přečíst. Zkuste to znovu.',
    'crm.pages.customersList.states.empty': 'Tomuto filtru neodpovídají žádní zákazníci.',
    'crm.pages.customersList.states.forbidden': 'Nemáte oprávnění zobrazit zákazníky.',
    'crm.pages.customersList.states.internal':
      'Seznam zákazníků se nepodařilo bezpečně načíst. Zkuste to znovu.',
    'crm.pages.customersList.states.loading': 'Načítání zákazníků…',
    'crm.pages.customersList.states.retry': 'Zkusit znovu',
    'crm.pages.customersList.states.retrying': 'Opakování…',
    'crm.pages.customersList.states.transport':
      'Seznam zákazníků není dostupný. Zkontrolujte připojení a zkuste to znovu.',
    'crm.pages.customersList.states.unavailable':
      'Seznam zákazníků je dočasně nedostupný. Zkuste to znovu.',
    'crm.pages.customersList.status.active': 'Aktivní',
    'crm.pages.customersList.status.archived': 'Archivovaný',
    'crm.pages.customersList.table.actions': 'Akce',
    'crm.pages.customersList.table.archive': 'Archivovat',
    'crm.pages.customersList.table.archiving': 'Archivace…',
    'crm.pages.customersList.table.caption': 'Zákazníci',
    'crm.pages.customersList.table.createdAt': 'Vytvořeno',
    'crm.pages.customersList.table.edit': 'Upravit',
    'crm.pages.customersList.table.name': 'Jméno zákazníka',
    'crm.pages.customersList.table.status': 'Stav',
    'crm.pages.customersList.table.unarchive': 'Odarchivovat',
    'crm.pages.customersList.table.unarchiving': 'Ruším archivaci…',
    'crm.pages.customersList.table.updatedAt': 'Aktualizováno',
  },
  en: {
    'crm.pages.customerCreate.title': 'Create Customer',
    'crm.pages.customerEdit.title': 'Edit Customer',
    'crm.pages.customersList.filter.active': 'Active',
    'crm.pages.customersList.filter.all': 'All',
    'crm.pages.customersList.filter.archived': 'Archived',
    'crm.pages.customersList.filter.label': 'Customer status',
    'crm.pages.customersList.filter.placeholder': 'Choose a status',
    'crm.pages.customersList.lifecycle.authenticationExpired': 'Your session expired.',
    'crm.pages.customersList.lifecycle.conflict': 'The status changed.',
    'crm.pages.customersList.lifecycle.forbidden': 'The change is forbidden.',
    'crm.pages.customersList.lifecycle.invalid': 'The request is invalid.',
    'crm.pages.customersList.lifecycle.notFound': 'The Customer was not found.',
    'crm.pages.customersList.lifecycle.unavailable': 'The change is unavailable.',
    'crm.pages.customersList.lifecycle.unexpected': 'The change failed.',
    'crm.pages.customersList.pagination.label': 'Customer list pages',
    'crm.pages.customersList.pagination.next': 'Next',
    'crm.pages.customersList.pagination.previous': 'Previous',
    'crm.pages.customersList.states.authenticationExpired':
      'Your session has expired. Try again after signing in.',
    'crm.pages.customersList.states.decode':
      'The Customer list response could not be read. Try again.',
    'crm.pages.customersList.states.empty': 'No Customers match this filter.',
    'crm.pages.customersList.states.forbidden': 'You do not have permission to view Customers.',
    'crm.pages.customersList.states.internal':
      'The Customer list could not be loaded safely. Try again.',
    'crm.pages.customersList.states.loading': 'Loading Customers…',
    'crm.pages.customersList.states.retry': 'Try again',
    'crm.pages.customersList.states.retrying': 'Trying again…',
    'crm.pages.customersList.states.transport':
      'The Customer list could not be reached. Check your connection and try again.',
    'crm.pages.customersList.states.unavailable':
      'The Customer list is temporarily unavailable. Try again.',
    'crm.pages.customersList.status.active': 'Active',
    'crm.pages.customersList.status.archived': 'Archived',
    'crm.pages.customersList.table.actions': 'Actions',
    'crm.pages.customersList.table.archive': 'Archive',
    'crm.pages.customersList.table.archiving': 'Archiving…',
    'crm.pages.customersList.table.caption': 'Customers',
    'crm.pages.customersList.table.createdAt': 'Created',
    'crm.pages.customersList.table.edit': 'Edit',
    'crm.pages.customersList.table.name': 'Customer name',
    'crm.pages.customersList.table.status': 'Status',
    'crm.pages.customersList.table.unarchive': 'Unarchive',
    'crm.pages.customersList.table.unarchiving': 'Unarchiving…',
    'crm.pages.customersList.table.updatedAt': 'Updated',
  },
} as const;

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    language: localeState.current,
    t: (key: keyof (typeof translations)['en']) => translations[localeState.current][key] ?? key,
  }),
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a {...props} href={to}>
      {children}
    </a>
  ),
  useLocation: ({ select }: { select: (location: { searchStr: string }) => string }) =>
    select({ searchStr: searchState.current }),
  useNavigate: () => navigateMock,
}));

rstest.mock('../../src/api/crm-client.ts', () => ({
  archiveCustomer: archiveCustomerMock,
  getCustomerList: getCustomerListMock,
  runEffectRequest: runEffectRequestMock,
  unarchiveCustomer: unarchiveCustomerMock,
}));

rstest.mock('../../src/routes/ultramodern-route-head.tsx', () => ({
  UltramodernRouteHead: () => null,
}));

const activeCustomer = {
  archivedAt: null,
  createdAt: '2026-08-13T08:15:00.000Z',
  customerId: '11111111-1111-4111-8111-111111111111',
  dic: null,
  dissolvedOn: null,
  establishedOn: null,
  ico: null,
  legalFormCode: null,
  name: 'Acme Property Group',
  updatedAt: '2026-08-14T09:30:00.000Z',
} as const;
const archivedCustomer = {
  archivedAt: '2026-08-14T10:00:00.000Z',
  createdAt: '2026-07-01T12:00:00.000Z',
  customerId: '22222222-2222-4222-8222-222222222222',
  dic: null,
  dissolvedOn: null,
  establishedOn: null,
  ico: null,
  legalFormCode: null,
  name: 'Former Customer',
  updatedAt: '2026-08-14T10:00:00.000Z',
} as const;

const success = (items = [activeCustomer, archivedCustomer], nextOffset: null | number = 25) =>
  Effect.succeed({ items, nextOffset });

const formatDate = (value: string, language: string) =>
  new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );

const flattenKeys = flattenCatalogKeys;

beforeEach(() => {
  localeState.current = 'en';
  searchState.current = '';
  navigateMock.mockResolvedValue();
  archiveCustomerMock.mockReturnValue(Effect.succeed({ ...activeCustomer, archivedAt: 'now' }));
  getCustomerListMock.mockReturnValue(success());
  runEffectRequestMock.mockImplementation((effect: Effect.Effect<unknown, unknown>) =>
    Effect.runPromise(effect),
  );
  unarchiveCustomerMock.mockReturnValue(Effect.succeed({ ...archivedCustomer, archivedAt: null }));
});

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

describe('Customer list URL state', () => {
  test('accepts only one exact status and one bounded non-negative integer offset', () => {
    expect(parseCustomerListSearch('?status=archived&offset=50')).toEqual({
      offset: 50,
      status: 'archived',
    });
    expect(parseCustomerListSearch('?status=all&offset=0')).toEqual({ offset: 0, status: 'all' });
    for (const search of ['', '?status=unknown&offset=-1']) {
      expect(parseCustomerListSearch(search)).toEqual({ offset: 0, status: 'active' });
    }
    expect(parseCustomerListSearch('?status=active&status=all&offset=1')).toEqual({
      offset: 1,
      status: 'active',
    });
    for (const search of [
      '?status=archived&offset=1.5',
      '?status=archived&offset=9007199254740991',
      '?status=archived&offset=25&offset=50',
    ]) {
      expect(parseCustomerListSearch(search)).toEqual({ offset: 0, status: 'archived' });
    }
  });

  test('builds a stable query key and localized links while retaining unrelated query state', () => {
    expect(customerListQueryKey({ offset: 25, status: 'archived' })).toEqual([
      'crm',
      'customers',
      'list',
      { limit: CUSTOMER_LIST_PAGE_SIZE, offset: 25, status: 'archived' },
    ]);
    expect(buildCustomerListHref('en', '?view=compact&status=all&offset=50', 'active', 0)).toBe(
      '/en/crm/customers?view=compact&status=active',
    );
  });
});

test('loads the initial page once through the typed CRM client with the exact bounded payload', async () => {
  render(<CustomersListPage />);

  await screen.findByRole('table', { name: 'Customers' });
  expect(getCustomerListMock).toHaveBeenCalledTimes(1);
  expect(getCustomerListMock).toHaveBeenCalledWith(
    { filter: 'active', limit: 25, offset: 0 },
    {
      baseUrl: 'http://localhost:4101/crm-api',
      correlationId: expect.any(String),
      locale: 'en',
    },
  );
  expect(runEffectRequestMock).toHaveBeenCalledTimes(1);
});

test('loads URL-derived archive state through the same client seam', async () => {
  searchState.current = '?status=archived&offset=25';
  render(<CustomersListPage />);

  await screen.findByRole('table', { name: 'Customers' });
  expect(getCustomerListMock).toHaveBeenCalledWith(
    { filter: 'archived', limit: 25, offset: 25 },
    {
      baseUrl: 'http://localhost:4101/crm-api',
      correlationId: expect.any(String),
      locale: 'en',
    },
  );
});

test('renders semantic Customer values, ordered rows, localized dates, badges, and honest links', async () => {
  searchState.current = '?view=compact&status=all&offset=25';
  getCustomerListMock.mockReturnValue(success([activeCustomer, archivedCustomer], 50));
  render(<CustomersListPage />);

  await screen.findByText('Acme Property Group');
  const table = screen.getByRole('table', { name: 'Customers' });
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent),
  ).toEqual(['Customer name', 'Status', 'Created', 'Updated', 'Actions']);
  expect(
    within(table).getByRole('columnheader', { name: 'Actions' }).firstElementChild?.className,
  ).toContain('justify-end');
  const rows = within(table).getAllByRole('row');
  expect(rows).toHaveLength(3);
  const activeRow = requireRow(rows, 1);
  expect(
    within(activeRow).getByRole('link', { name: activeCustomer.name }).getAttribute('href'),
  ).toBe(`/en/crm/customers/${activeCustomer.customerId}`);
  const editLink = within(activeRow).getByRole('link', { name: 'Edit' });
  expect(editLink.getAttribute('href')).toBe(`/en/crm/customers/${activeCustomer.customerId}/edit`);
  expect(editLink.className).toBe(screen.getByRole('link', { name: 'Create Customer' }).className);
  expect(editLink.parentElement?.className).toContain('justify-end');
  expect(rows[1]?.textContent).toContain('Acme Property Group');
  expect(rows[1]?.textContent).not.toContain(activeCustomer.customerId);
  expect(rows[1]?.textContent).toContain('Active');
  expect(rows[2]?.textContent).toContain('Former Customer');
  expect(rows[2]?.textContent).toContain('Archived');
  expect(within(table).getByText(formatDate(activeCustomer.createdAt, 'en'))).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Previous' }).getAttribute('href')).toBe(
    '/en/crm/customers?view=compact&status=all',
  );
  expect(screen.getByRole('link', { name: 'Next' }).getAttribute('href')).toBe(
    '/en/crm/customers?view=compact&status=all&offset=50',
  );
});

test('archives active Customers and unarchives archived Customers through the typed BFF clients', async () => {
  searchState.current = '?status=all';
  const user = userEvent.setup();
  render(<CustomersListPage />);

  const archiveButton = await screen.findByRole('button', { name: 'Archive' });
  const unarchiveButton = screen.getByRole('button', { name: 'Unarchive' });
  expect(archiveButton.className).toContain('border-button-border-danger');
  expect(unarchiveButton.className).toContain('border-button-border-warning');

  await user.click(archiveButton);
  expect(archiveCustomerMock).toHaveBeenCalledWith(
    { customerId: activeCustomer.customerId },
    {
      baseUrl: 'http://localhost:4101/crm-api',
      correlationId: expect.any(String),
      idempotencyKey: expect.any(String),
      locale: 'en',
    },
  );
  await waitFor(() => expect(getCustomerListMock).toHaveBeenCalledTimes(2));

  await user.click(unarchiveButton);
  expect(unarchiveCustomerMock).toHaveBeenCalledWith(
    { customerId: archivedCustomer.customerId },
    {
      baseUrl: 'http://localhost:4101/crm-api',
      correlationId: expect.any(String),
      idempotencyKey: expect.any(String),
      locale: 'en',
    },
  );
  await waitFor(() => expect(getCustomerListMock).toHaveBeenCalledTimes(3));
});

test('preserves the final table geometry and a polite status while loading', () => {
  getCustomerListMock.mockReturnValue(Effect.never);
  render(<CustomersListPage />);

  expect(screen.getByRole('status').textContent).toBe('Loading Customers…');
  const table = screen.getByRole('table', { name: 'Customers' });
  expect(table.getAttribute('aria-busy')).toBe('true');
  expect(within(table).getAllByRole('row')).toHaveLength(4);
  expect(table.querySelectorAll('tbody td')).toHaveLength(15);
});

test('shows the empty Customer table without data rows or a pager', async () => {
  getCustomerListMock.mockReturnValue(success([], null));
  render(<CustomersListPage />);

  const table = await waitFor(() => {
    const currentTable = screen.getByRole('table', { name: 'Customers' });
    expect(currentTable.querySelectorAll('tbody tr')).toHaveLength(0);
    return currentTable;
  });
  expect(within(table).getAllByRole('row')).toHaveLength(1);
  const emptyDescription = screen.getByText('No Customers match this filter.');
  expect(emptyDescription.className).toContain('crm:sr-only');
  expect(table.getAttribute('aria-describedby')).toBe(emptyDescription.id);
  expect(screen.getByRole('link', { name: 'Create Customer' }).getAttribute('href')).toBe(
    '/en/crm/customers/context/new',
  );
  expect(screen.queryByRole('navigation', { name: 'Customer list pages' })).toBeNull();
});

test('shows a definite forbidden state without suggesting retry', async () => {
  getCustomerListMock.mockReturnValue(Effect.fail({ _tag: 'CustomerListForbiddenProblem' }));
  render(<CustomersListPage />);

  await screen.findByText('You do not have permission to view Customers.');
  expect(screen.getByRole('status').textContent).toBe(
    'You do not have permission to view Customers.',
  );
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

test('retries one unavailable request by keyboard and restores focus after success', async () => {
  getCustomerListMock
    .mockReturnValueOnce(Effect.fail({ _tag: 'CustomerListUnavailableProblem' }))
    .mockReturnValueOnce(success([activeCustomer], null));
  const user = userEvent.setup();
  render(<CustomersListPage />);

  const retry = await screen.findByRole('button', { name: 'Try again' });
  retry.focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByText('Acme Property Group')).toBeTruthy();
  expect(getCustomerListMock).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('customers-results')));
});

test.each([
  [
    'transport',
    'TransportError',
    'The Customer list could not be reached. Check your connection and try again.',
  ],
  ['decode', 'DecodeError', 'The Customer list response could not be read. Try again.'],
  ['empty response', 'EmptyBodyError', 'The Customer list response could not be read. Try again.'],
] as const)(
  'renders the localized %s failure and retries through the query seam',
  async (_reason, reasonTag, expectedCopy) => {
    getCustomerListMock
      .mockReturnValueOnce(Effect.fail({ _tag: 'HttpClientError', reason: { _tag: reasonTag } }))
      .mockReturnValueOnce(success([activeCustomer], null));
    const user = userEvent.setup();
    render(<CustomersListPage />);

    expect(await screen.findByText(expectedCopy)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(expectedCopy);
    const retry = screen.getByRole('button', { name: 'Try again' });
    retry.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Acme Property Group')).toBeTruthy();
    expect(getCustomerListMock).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('customers-results')),
    );
  },
);

test('changes the status filter by keyboard, retains safe query state, and resets the offset', async () => {
  searchState.current = '?view=compact&status=active&offset=50';
  const user = userEvent.setup();
  render(<CustomersListPage />);
  await screen.findByRole('table', { name: 'Customers' });

  const filter = screen.getByRole('combobox', { name: 'Customer status' });
  filter.focus();
  await user.keyboard('{Enter}{ArrowDown}{Enter}');
  expect(navigateMock).toHaveBeenCalledWith({
    to: '/en/crm/customers?view=compact&status=archived',
  });
});

test('renders Czech-owned heading, filter, status, dates, errors, retry, and navigation copy', async () => {
  localeState.current = 'cs';
  searchState.current = '?status=all&offset=25';
  getCustomerListMock.mockReturnValue(success([archivedCustomer], 50));
  render(<CustomersListPage />);

  expect(await screen.findByRole('heading', { name: 'Zákazníci' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Vytvořit zákazníka' }).getAttribute('href')).toBe(
    '/cs/crm/customers/context/new',
  );
  expect(screen.getByRole('combobox', { name: 'Stav zákazníka' })).toBeTruthy();
  expect(await screen.findByText('Archivovaný')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Upravit' })).toBeTruthy();
  expect(screen.getByText(formatDate(archivedCustomer.createdAt, 'cs'))).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Předchozí' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Další' })).toBeTruthy();

  cleanup();
  getCustomerListMock.mockReturnValue(
    Effect.fail({ _tag: 'GatewayAuthenticationRequiredProblem' }),
  );
  render(<CustomersListPage />);
  await screen.findByText('Vaše relace vypršela. Po přihlášení to zkuste znovu.');
  expect(screen.getByRole('status').textContent).toBe(
    'Vaše relace vypršela. Po přihlášení to zkuste znovu.',
  );
  expect(screen.getByRole('button', { name: 'Zkusit znovu' })).toBeTruthy();
});

test('maps every public failure family into a closed presentation state', () => {
  expect(classifyCustomerListError({ _tag: 'CustomerListForbiddenProblem' })).toEqual({
    state: 'forbidden',
  });
  expect(classifyCustomerListError({ _tag: 'CustomerListAuthenticationProblem' })).toEqual({
    state: 'authentication_expired',
  });
  expect(classifyCustomerListError({ _tag: 'CustomerListUnavailableProblem' })).toEqual({
    reason: 'backend',
    state: 'unavailable',
  });
  expect(classifyCustomerListError({ _tag: 'SchemaError' })).toEqual({
    reason: 'decode',
    state: 'unavailable',
  });
  expect(classifyCustomerListError({ _tag: 'CustomerListInternalProblem' })).toEqual({
    reason: 'internal',
    state: 'unavailable',
  });
  expect(classifyCustomerListError({ _tag: 'CustomerListInvalidProblem' })).toEqual({
    reason: 'internal',
    state: 'unavailable',
  });
  expect(classifyCustomerListError({ _tag: 'GatewayAudienceInvalidProblem' })).toEqual({
    reason: 'internal',
    state: 'unavailable',
  });
  expect(classifyCustomerListError({ _tag: 'GatewayInternalProblem' })).toEqual({
    reason: 'internal',
    state: 'unavailable',
  });
});

test('owns the UI-kit token, theme, class source, and local overflow boundary', async () => {
  const appCss = readFileSync(new URL('../../src/routes/index.css', import.meta.url), 'utf-8');
  const federationConfig = readFileSync(
    new URL('../../module-federation.config.ts', import.meta.url),
    'utf-8',
  );
  const federationPage = readFileSync(
    new URL('../../src/federation/page-customers-list.tsx', import.meta.url),
    'utf-8',
  );
  const uiKitCss = readFileSync(new URL('../../src/routes/ui-kit.css', import.meta.url), 'utf-8');
  expect(uiKitCss).toContain("@import '@techsio/ui-kit/tokens-with-tailwind';");
  expect(uiKitCss).toContain("@import '@techsio/ui-kit/theme.css';");
  expect(uiKitCss).toContain("@source '../../node_modules/@techsio/ui-kit/dist';");
  expect(appCss).toContain("@import 'tailwindcss' prefix(crm) source(none);");
  expect(federationConfig).toContain("!asset.includes('/async-index.')");
  expect(federationPage).toContain("import '../routes/index.css';");

  render(<CustomersListPage />);
  await screen.findByRole('table', { name: 'Customers' });
  expect(screen.getByTestId('customers-table-overflow').className).toContain('crm:overflow-x-auto');
  expect(screen.getByRole('table', { name: 'Customers' }).className).toContain('crm:min-w-3xl');
});

test('keeps English and Czech Customer-list locale structures in parity', () => {
  expect(flattenKeys(csCatalog.crm.pages.customersList)).toEqual(
    flattenKeys(enCatalog.crm.pages.customersList),
  );
});
