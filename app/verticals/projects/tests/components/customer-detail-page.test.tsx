// @effect-diagnostics asyncFunction:off anyUnknownInErrorContext:off nodeBuiltinImport:off
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect } from 'effect';
import type { AnchorHTMLAttributes } from 'react';
import csCatalog from '../../locales/cs/projects.json';
import enCatalog from '../../locales/en/projects.json';
import { flattenCatalogKeys } from '../support/locale-catalog.ts';
import StandaloneCustomerDetailPage, {
  CONTACT_LIST_PAGE_SIZE,
  CustomerDetailPage,
  buildCustomerContactListHref,
  classifyContactListError,
  classifyCustomerDetailError,
  contactListQueryKey,
  customerDetailQueryKey,
  decodeCustomerDetailId,
  formatCustomerDateOnly,
  parseCustomerContactListSearch,
} from '../../src/routes/[lang]/projects/customers/[id]/page.tsx';

interface LocaleState {
  current: 'cs' | 'en';
}
interface RouteParamsState {
  current: Readonly<Partial<Record<'id', string>>>;
}

Object.assign(globalThis, {
  ULTRAMODERN_PROJECTS_API_BASE_URL: 'http://localhost:4101/projects-api',
});

const {
  archiveContactMock,
  getContactListMock,
  getCustomerDetailMock,
  localeState,
  navigateMock,
  routeParamsState,
  runEffectRequestMock,
  searchState,
  unarchiveContactMock,
} = rstest.hoisted(() => {
  const state: LocaleState = { current: 'en' };
  const paramsState: RouteParamsState = { current: {} };
  return {
    archiveContactMock: rstest.fn(),
    getContactListMock: rstest.fn(),
    getCustomerDetailMock: rstest.fn(),
    localeState: state,
    navigateMock: rstest.fn(() => Promise.resolve()),
    routeParamsState: paramsState,
    runEffectRequestMock: rstest.fn(),
    searchState: { current: '' },
    unarchiveContactMock: rstest.fn(),
  };
});

const getDescriptionList = (): HTMLElement => {
  const list = document.querySelector('dl');
  if (list === null) {
    throw new Error('Expected Customer details description list');
  }
  return list;
};

const requireRow = (rows: readonly HTMLElement[], index: number): HTMLElement => {
  const row = rows[index];
  if (row === undefined) {
    throw new Error(`Expected table row ${index}`);
  }
  return row;
};

const translations = {
  cs: {
    'projects.pages.contactCreate.title': 'Vytvořit kontakt',
    'projects.pages.contactEdit.title': 'Upravit kontakt',
    'projects.pages.customerDetail.back': 'Zpět',
    'projects.pages.customerDetail.contacts.filter.active': 'Aktivní',
    'projects.pages.customerDetail.contacts.filter.all': 'Všichni',
    'projects.pages.customerDetail.contacts.filter.archived': 'Archivovaní',
    'projects.pages.customerDetail.contacts.filter.label': 'Stav kontaktu',
    'projects.pages.customerDetail.contacts.filter.placeholder': 'Vyberte stav',
    'projects.pages.customerDetail.contacts.heading': 'Kontakty',
    'projects.pages.customerDetail.contacts.lifecycle.authenticationExpired': 'Relace vypršela.',
    'projects.pages.customerDetail.contacts.lifecycle.conflict': 'Stav se změnil.',
    'projects.pages.customerDetail.contacts.lifecycle.forbidden': 'Změna není povolena.',
    'projects.pages.customerDetail.contacts.lifecycle.invalid': 'Požadavek není platný.',
    'projects.pages.customerDetail.contacts.lifecycle.notFound': 'Kontakt nebyl nalezen.',
    'projects.pages.customerDetail.contacts.lifecycle.unavailable': 'Změna není dostupná.',
    'projects.pages.customerDetail.contacts.lifecycle.unexpected': 'Změna se nezdařila.',
    'projects.pages.customerDetail.contacts.pagination.label': 'Stránky kontaktů zákazníka',
    'projects.pages.customerDetail.contacts.pagination.next': 'Další',
    'projects.pages.customerDetail.contacts.pagination.previous': 'Předchozí',
    'projects.pages.customerDetail.contacts.states.authenticationExpired':
      'Vaše relace vypršela. Po přihlášení načtěte kontakty znovu.',
    'projects.pages.customerDetail.contacts.states.decode':
      'Odpověď se seznamem kontaktů se nepodařilo přečíst. Zkuste to znovu.',
    'projects.pages.customerDetail.contacts.states.empty':
      'Tomuto filtru neodpovídají žádné kontakty.',
    'projects.pages.customerDetail.contacts.states.forbidden':
      'Nemáte oprávnění zobrazit kontakty tohoto zákazníka.',
    'projects.pages.customerDetail.contacts.states.internal':
      'Kontakty se nepodařilo bezpečně načíst. Zkuste to znovu.',
    'projects.pages.customerDetail.contacts.states.loading': 'Načítání kontaktů…',
    'projects.pages.customerDetail.contacts.states.parentNotFound':
      'Zákazník pro tento seznam kontaktů již neexistuje.',
    'projects.pages.customerDetail.contacts.states.retry': 'Zkusit znovu',
    'projects.pages.customerDetail.contacts.states.retrying': 'Opakování…',
    'projects.pages.customerDetail.contacts.states.transport':
      'Kontakty nejsou dostupné. Zkontrolujte připojení a zkuste to znovu.',
    'projects.pages.customerDetail.contacts.states.unavailable':
      'Kontakty jsou dočasně nedostupné. Zkuste to znovu.',
    'projects.pages.customerDetail.contacts.status.active': 'Aktivní',
    'projects.pages.customerDetail.contacts.status.archived': 'Archivovaný',
    'projects.pages.customerDetail.contacts.table.actions': 'Akce',
    'projects.pages.customerDetail.contacts.table.archive': 'Archivovat',
    'projects.pages.customerDetail.contacts.table.archiving': 'Archivuji…',
    'projects.pages.customerDetail.contacts.table.caption': 'Kontakty zákazníka',
    'projects.pages.customerDetail.contacts.table.edit': 'Upravit',
    'projects.pages.customerDetail.contacts.table.email': 'E-mail',
    'projects.pages.customerDetail.contacts.table.name': 'Jméno',
    'projects.pages.customerDetail.contacts.table.phone': 'Telefon',
    'projects.pages.customerDetail.contacts.table.status': 'Stav',
    'projects.pages.customerDetail.contacts.table.unarchive': 'Odarchivovat',
    'projects.pages.customerDetail.contacts.table.unarchiving': 'Ruším archivaci…',
    'projects.pages.customerDetail.edit': 'Upravit',
    'projects.pages.customerDetail.fields.createdAt': 'Vytvořeno',
    'projects.pages.customerDetail.fields.customerId': 'ID zákazníka',
    'projects.pages.customerDetail.fields.dic': 'DIČ',
    'projects.pages.customerDetail.fields.dissolvedOn': 'Datum zániku',
    'projects.pages.customerDetail.fields.establishedOn': 'Datum vzniku',
    'projects.pages.customerDetail.fields.ico': 'IČO',
    'projects.pages.customerDetail.fields.legalFormCode': 'Kód právní formy',
    'projects.pages.customerDetail.fields.status': 'Stav',
    'projects.pages.customerDetail.fields.unavailable': 'Neuvedeno',
    'projects.pages.customerDetail.fields.updatedAt': 'Aktualizováno',
    'projects.pages.customerDetail.lifecycle.active': 'Aktivní',
    'projects.pages.customerDetail.lifecycle.archived': 'Archivovaný',
    'projects.pages.customerDetail.states.authenticationExpired':
      'Vaše relace vypršela. Po přihlášení to zkuste znovu.',
    'projects.pages.customerDetail.states.decode':
      'Odpověď s údaji zákazníka se nepodařilo přečíst. Zkuste to znovu.',
    'projects.pages.customerDetail.states.forbidden': 'Nemáte oprávnění zobrazit tohoto zákazníka.',
    'projects.pages.customerDetail.states.internal':
      'Zákazníka se nepodařilo bezpečně načíst. Zkuste to znovu.',
    'projects.pages.customerDetail.states.loading': 'Načítání údajů zákazníka…',
    'projects.pages.customerDetail.states.notFound': 'Tohoto zákazníka se nepodařilo najít.',
    'projects.pages.customerDetail.states.retry': 'Zkusit znovu',
    'projects.pages.customerDetail.states.retrying': 'Opakování…',
    'projects.pages.customerDetail.states.transport':
      'Zákazník není dostupný. Zkontrolujte připojení a zkuste to znovu.',
    'projects.pages.customerDetail.states.unavailable':
      'Zákazník je dočasně nedostupný. Zkuste to znovu.',
    'projects.pages.customerDetail.title': 'Detail zákazníka',
  },
  en: {
    'projects.pages.contactCreate.title': 'Create Contact',
    'projects.pages.contactEdit.title': 'Edit Contact',
    'projects.pages.customerDetail.back': 'Back',
    'projects.pages.customerDetail.contacts.filter.active': 'Active',
    'projects.pages.customerDetail.contacts.filter.all': 'All',
    'projects.pages.customerDetail.contacts.filter.archived': 'Archived',
    'projects.pages.customerDetail.contacts.filter.label': 'Contact status',
    'projects.pages.customerDetail.contacts.filter.placeholder': 'Choose a status',
    'projects.pages.customerDetail.contacts.heading': 'Contacts',
    'projects.pages.customerDetail.contacts.lifecycle.authenticationExpired':
      'Your session expired.',
    'projects.pages.customerDetail.contacts.lifecycle.conflict': 'The status changed.',
    'projects.pages.customerDetail.contacts.lifecycle.forbidden': 'The change is forbidden.',
    'projects.pages.customerDetail.contacts.lifecycle.invalid': 'The request is invalid.',
    'projects.pages.customerDetail.contacts.lifecycle.notFound': 'The Contact was not found.',
    'projects.pages.customerDetail.contacts.lifecycle.unavailable': 'The change is unavailable.',
    'projects.pages.customerDetail.contacts.lifecycle.unexpected': 'The change failed.',
    'projects.pages.customerDetail.contacts.pagination.label': 'Customer Contact pages',
    'projects.pages.customerDetail.contacts.pagination.next': 'Next',
    'projects.pages.customerDetail.contacts.pagination.previous': 'Previous',
    'projects.pages.customerDetail.contacts.states.authenticationExpired':
      'Your session has expired. Sign in and load the Contacts again.',
    'projects.pages.customerDetail.contacts.states.decode':
      'The Contact list response could not be read. Try again.',
    'projects.pages.customerDetail.contacts.states.empty': 'No Contacts match this filter.',
    'projects.pages.customerDetail.contacts.states.forbidden':
      'You do not have permission to view this Customer’s Contacts.',
    'projects.pages.customerDetail.contacts.states.internal':
      'The Contacts could not be loaded safely. Try again.',
    'projects.pages.customerDetail.contacts.states.loading': 'Loading Contacts…',
    'projects.pages.customerDetail.contacts.states.parentNotFound':
      'The Customer for this Contact list no longer exists.',
    'projects.pages.customerDetail.contacts.states.retry': 'Try again',
    'projects.pages.customerDetail.contacts.states.retrying': 'Trying again…',
    'projects.pages.customerDetail.contacts.states.transport':
      'The Contacts could not be reached. Check your connection and try again.',
    'projects.pages.customerDetail.contacts.states.unavailable':
      'The Contacts are temporarily unavailable. Try again.',
    'projects.pages.customerDetail.contacts.status.active': 'Active',
    'projects.pages.customerDetail.contacts.status.archived': 'Archived',
    'projects.pages.customerDetail.contacts.table.actions': 'Actions',
    'projects.pages.customerDetail.contacts.table.archive': 'Archive',
    'projects.pages.customerDetail.contacts.table.archiving': 'Archiving…',
    'projects.pages.customerDetail.contacts.table.caption': 'Customer Contacts',
    'projects.pages.customerDetail.contacts.table.edit': 'Edit',
    'projects.pages.customerDetail.contacts.table.email': 'Email',
    'projects.pages.customerDetail.contacts.table.name': 'Name',
    'projects.pages.customerDetail.contacts.table.phone': 'Phone',
    'projects.pages.customerDetail.contacts.table.status': 'Status',
    'projects.pages.customerDetail.contacts.table.unarchive': 'Unarchive',
    'projects.pages.customerDetail.contacts.table.unarchiving': 'Unarchiving…',
    'projects.pages.customerDetail.edit': 'Edit',
    'projects.pages.customerDetail.fields.createdAt': 'Created',
    'projects.pages.customerDetail.fields.customerId': 'Customer ID',
    'projects.pages.customerDetail.fields.dic': 'Tax ID',
    'projects.pages.customerDetail.fields.dissolvedOn': 'Dissolution date',
    'projects.pages.customerDetail.fields.establishedOn': 'Establishment date',
    'projects.pages.customerDetail.fields.ico': 'Company ID (IČO)',
    'projects.pages.customerDetail.fields.legalFormCode': 'Legal-form code',
    'projects.pages.customerDetail.fields.status': 'Status',
    'projects.pages.customerDetail.fields.unavailable': 'Not available',
    'projects.pages.customerDetail.fields.updatedAt': 'Updated',
    'projects.pages.customerDetail.lifecycle.active': 'Active',
    'projects.pages.customerDetail.lifecycle.archived': 'Archived',
    'projects.pages.customerDetail.states.authenticationExpired':
      'Your session has expired. Try again after signing in.',
    'projects.pages.customerDetail.states.decode':
      'The Customer response could not be read. Try again.',
    'projects.pages.customerDetail.states.forbidden':
      'You do not have permission to view this Customer.',
    'projects.pages.customerDetail.states.internal':
      'The Customer could not be loaded safely. Try again.',
    'projects.pages.customerDetail.states.loading': 'Loading Customer details…',
    'projects.pages.customerDetail.states.notFound': 'This Customer could not be found.',
    'projects.pages.customerDetail.states.retry': 'Try again',
    'projects.pages.customerDetail.states.retrying': 'Trying again…',
    'projects.pages.customerDetail.states.transport':
      'The Customer could not be reached. Check your connection and try again.',
    'projects.pages.customerDetail.states.unavailable':
      'The Customer is temporarily unavailable. Try again.',
    'projects.pages.customerDetail.title': 'Customer detail',
  },
} as const;

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    language: localeState.current,
    t: (key: keyof (typeof translations)['en']) => translations[localeState.current][key] ?? key,
  }),
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  Link: ({
    children,
    to,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { readonly to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: ({ select }: { select: (location: { searchStr: string }) => string }) =>
    select({ searchStr: searchState.current }),
  useNavigate: () => navigateMock,
  useParams: () => routeParamsState.current,
}));

rstest.mock('../../src/api/projects-client.ts', () => ({
  archiveContact: archiveContactMock,
  getContactList: getContactListMock,
  getCustomerDetail: getCustomerDetailMock,
  runEffectRequest: runEffectRequestMock,
  unarchiveContact: unarchiveContactMock,
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

const completeCustomer = {
  ...activeCustomer,
  dic: 'CZ00123456',
  dissolvedOn: '2026-12-31',
  establishedOn: '2026-01-01',
  ico: '00123456',
  legalFormCode: '112',
} as const;

const archivedCustomer = {
  ...completeCustomer,
  archivedAt: '2026-08-14T10:00:00.000Z',
  name: 'Former Customer with a deliberately long business name',
} as const;

const contacts = [
  {
    archivedAt: null,
    contactId: '22222222-2222-4222-8222-222222222222',
    createdAt: '2026-08-14T10:15:00.000Z',
    customerId: activeCustomer.customerId,
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    phone: '+420 111 222 333',
    updatedAt: '2026-08-14T10:15:00.000Z',
  },
  {
    archivedAt: null,
    contactId: '33333333-3333-4333-8333-333333333333',
    createdAt: '2026-08-14T11:15:00.000Z',
    customerId: activeCustomer.customerId,
    email: 'grace@example.com',
    name: 'Grace Hopper',
    phone: '+420 444 555 666',
    updatedAt: '2026-08-14T11:15:00.000Z',
  },
] as const;

const archivedContact = {
  ...contacts[1],
  archivedAt: '2026-08-15T12:00:00.000Z',
} as const;

const flattenKeys = flattenCatalogKeys;

beforeEach(() => {
  localeState.current = 'en';
  navigateMock.mockResolvedValue();
  routeParamsState.current = {};
  searchState.current = '';
  archiveContactMock.mockReturnValue(Effect.succeed({ ...contacts[0], archivedAt: 'now' }));
  getContactListMock.mockReturnValue(Effect.succeed({ items: contacts, nextOffset: null }));
  getCustomerDetailMock.mockReturnValue(Effect.succeed(activeCustomer));
  runEffectRequestMock.mockImplementation((effect: Effect.Effect<unknown, unknown>) =>
    Effect.runPromise(effect),
  );
  unarchiveContactMock.mockReturnValue(Effect.succeed({ ...archivedContact, archivedAt: null }));
});

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

describe('Customer detail route input', () => {
  test('reads the dynamic Customer ID in the standalone route entrypoint', async () => {
    routeParamsState.current = { id: activeCustomer.customerId };

    render(<StandaloneCustomerDetailPage />);

    expect(await screen.findByRole('heading', { name: activeCustomer.name })).toBeTruthy();
    expect(await screen.findByRole('table', { name: 'Customer Contacts' })).toBeTruthy();
  });

  test('accepts only a bounded Customer UUID and builds an ID-specific query key', () => {
    expect(decodeCustomerDetailId(activeCustomer.customerId)).toBe(activeCustomer.customerId);
    for (const value of [undefined, '', 'customer-1', 'x'.repeat(201)]) {
      expect(decodeCustomerDetailId(value)).toBeUndefined();
    }
    expect(customerDetailQueryKey(activeCustomer.customerId)).toEqual([
      'projects',
      'customers',
      'detail',
      activeCustomer.customerId,
    ]);
    expect(contactListQueryKey(activeCustomer.customerId, 'archived', 25)).toEqual([
      'projects',
      'customers',
      activeCustomer.customerId,
      'contacts',
      { filter: 'archived', limit: CONTACT_LIST_PAGE_SIZE, offset: 25 },
    ]);
  });

  test.each([undefined, 'customer-1', 'x'.repeat(201)])(
    'maps invalid route ID %s to not found without invoking the BFF client',
    async (id) => {
      render(<CustomerDetailPage routeParams={id === undefined ? {} : { id }} />);

      expect(await screen.findByText('This Customer could not be found.')).toBeTruthy();
      expect(getCustomerDetailMock).not.toHaveBeenCalled();
      expect(getContactListMock).not.toHaveBeenCalled();
      expect(runEffectRequestMock).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    },
  );
});

describe('Customer Contact list URL state', () => {
  test('accepts only one exact status and one bounded non-negative integer offset', () => {
    expect(parseCustomerContactListSearch('?status=archived&offset=50')).toEqual({
      offset: 50,
      status: 'archived',
    });
    expect(parseCustomerContactListSearch('?status=all&offset=0')).toEqual({
      offset: 0,
      status: 'all',
    });
    for (const search of ['', '?status=unknown&offset=-1']) {
      expect(parseCustomerContactListSearch(search)).toEqual({ offset: 0, status: 'active' });
    }
    expect(parseCustomerContactListSearch('?status=active&status=all&offset=1')).toEqual({
      offset: 1,
      status: 'active',
    });
    for (const search of [
      '?status=archived&offset=1.5',
      '?status=archived&offset=9007199254740991',
      '?status=archived&offset=25&offset=50',
    ]) {
      expect(parseCustomerContactListSearch(search)).toEqual({ offset: 0, status: 'archived' });
    }
  });

  test('builds localized Customer detail links while retaining unrelated query state', () => {
    expect(
      buildCustomerContactListHref(
        'en',
        activeCustomer.customerId,
        '?view=compact&status=all&offset=50',
        'active',
        0,
      ),
    ).toBe(`/en/projects/customers/${activeCustomer.customerId}?view=compact&status=active`);
  });
});

test('loads the Customer and its active Contacts through the typed Projects client with exact BFF options', async () => {
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  await screen.findByRole('heading', { name: activeCustomer.name });
  await screen.findByRole('table', { name: 'Customer Contacts' });
  expect(getCustomerDetailMock).toHaveBeenCalledTimes(1);
  expect(getCustomerDetailMock).toHaveBeenCalledWith(
    { customerId: activeCustomer.customerId },
    {
      baseUrl: 'http://localhost:4101/projects-api',
      correlationId: expect.any(String),
      locale: 'en',
    },
  );
  expect(getContactListMock).toHaveBeenCalledTimes(1);
  expect(getContactListMock).toHaveBeenCalledWith(
    {
      customerId: activeCustomer.customerId,
      filter: 'active',
      limit: CONTACT_LIST_PAGE_SIZE,
      offset: 0,
    },
    {
      baseUrl: 'http://localhost:4101/projects-api',
      correlationId: expect.any(String),
      locale: 'en',
    },
  );
  expect(runEffectRequestMock).toHaveBeenCalledTimes(2);
});

test('loads URL-derived Contact status and pagination through the same client seam', async () => {
  searchState.current = '?status=archived&offset=25';
  getContactListMock.mockReturnValue(
    Effect.succeed({ items: [archivedContact], nextOffset: null }),
  );

  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  await screen.findByRole('button', { name: 'Unarchive' });
  expect(within(screen.getByRole('table')).getByText('Archived')).toBeTruthy();
  expect(getContactListMock).toHaveBeenCalledWith(
    {
      customerId: activeCustomer.customerId,
      filter: 'archived',
      limit: CONTACT_LIST_PAGE_SIZE,
      offset: 25,
    },
    expect.objectContaining({ locale: 'en' }),
  );
});

test('renders the Customer overview followed by ordered semantic Contact rows', async () => {
  getCustomerDetailMock.mockReturnValue(Effect.succeed(completeCustomer));
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  await screen.findByRole('heading', { name: completeCustomer.name });
  expect(screen.getByRole('link', { name: 'Back' }).getAttribute('href')).toBe(
    '/en/projects/customers',
  );
  expect(screen.getAllByRole('link', { name: 'Edit' })[0]?.getAttribute('href')).toBe(
    `/en/projects/customers/${activeCustomer.customerId}/edit`,
  );
  const list = getDescriptionList();
  expect(within(list).getByText('Customer ID')).toBeTruthy();
  expect(within(list).getByText(completeCustomer.customerId)).toBeTruthy();
  expect(within(list).getByText('Company ID (IČO)')).toBeTruthy();
  expect(within(list).getByText('00123456')).toBeTruthy();
  expect(within(list).getByText('Tax ID')).toBeTruthy();
  expect(within(list).getByText('CZ00123456')).toBeTruthy();
  expect(within(list).getByText('Legal-form code')).toBeTruthy();
  expect(within(list).getByText('112')).toBeTruthy();
  expect(within(list).getByText('Establishment date')).toBeTruthy();
  expect(within(list).getByText('Jan 1, 2026')).toBeTruthy();
  expect(within(list).getByText('Dissolution date')).toBeTruthy();
  expect(within(list).getByText('Dec 31, 2026')).toBeTruthy();
  expect(within(list).getByText('Active')).toBeTruthy();
  const times = list.querySelectorAll('time');
  expect(times).toHaveLength(4);
  expect([...times].map((time) => time.getAttribute('datetime'))).toEqual([
    completeCustomer.establishedOn,
    completeCustomer.dissolvedOn,
    completeCustomer.createdAt,
    completeCustomer.updatedAt,
  ]);
  expect(list?.className).toContain('projects:min-w-0');
  for (const term of list?.querySelectorAll('dt') ?? []) {
    expect(term.nextElementSibling?.tagName).toBe('DD');
  }
  for (const value of list?.querySelectorAll('code') ?? []) {
    expect(value.parentElement?.className).toContain('projects:break-all');
  }
  const contactsHeading = await screen.findByRole('heading', { name: 'Contacts' });
  const table = screen.getByRole('table', { name: 'Customer Contacts' });
  expect(contactsHeading.compareDocumentPosition(table)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent),
  ).toEqual(['Name', 'Status', 'Email', 'Phone', 'Actions']);
  expect(
    within(table).getByRole('columnheader', { name: 'Actions' }).firstElementChild?.className,
  ).toContain('justify-end');
  const rows = within(table).getAllByRole('row');
  expect(rows).toHaveLength(3);
  const activeRow = requireRow(rows, 1);
  const secondActiveRow = requireRow(rows, 2);
  expect(
    within(activeRow)
      .getAllByRole('cell')
      .map((cell) => cell.textContent),
  ).toEqual(['Ada Lovelace', 'Active', 'ada@example.com', '+420 111 222 333', 'EditArchive']);
  expect(within(activeRow).getByRole('link', { name: 'Ada Lovelace' }).getAttribute('href')).toBe(
    `/en/projects/customers/${activeCustomer.customerId}/contacts/${contacts[0].contactId}`,
  );
  expect(
    within(activeRow).getByRole('link', { name: 'ada@example.com' }).getAttribute('href'),
  ).toBe('mailto:ada@example.com');
  const editLink = within(activeRow).getByRole('link', { name: 'Edit' });
  expect(editLink.getAttribute('href')).toBe(
    `/en/projects/customers/${activeCustomer.customerId}/contacts/${contacts[0].contactId}/edit`,
  );
  expect(editLink.className).toBe(screen.getByRole('link', { name: 'Create Contact' }).className);
  expect(editLink.parentElement?.className).toContain('justify-end');
  expect(
    within(secondActiveRow)
      .getAllByRole('cell')
      .map((cell) => cell.textContent),
  ).toEqual(['Grace Hopper', 'Active', 'grace@example.com', '+420 444 555 666', 'EditArchive']);
  expect(
    within(secondActiveRow).getByRole('link', { name: 'grace@example.com' }).getAttribute('href'),
  ).toBe('mailto:grace@example.com');
  expect(within(table).getAllByText('Active')).toHaveLength(2);
  expect(screen.getByTestId('customer-contacts-table-overflow').className).toContain(
    'projects:overflow-x-auto',
  );
  expect(document.querySelector('[role="tablist"]')).toBeNull();
  expect(screen.queryByRole('heading', { name: /ares|address/iu })).toBeNull();
});

test('archives active Contacts and unarchives archived Contacts through the typed BFF clients', async () => {
  getContactListMock.mockReturnValue(
    Effect.succeed({ items: [contacts[0], archivedContact], nextOffset: null }),
  );
  const user = userEvent.setup();
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  const archiveButton = await screen.findByRole('button', { name: 'Archive' });
  const unarchiveButton = screen.getByRole('button', { name: 'Unarchive' });
  expect(archiveButton.className).toContain('border-button-border-danger');
  expect(unarchiveButton.className).toContain('border-button-border-warning');

  await user.click(archiveButton);
  expect(archiveContactMock).toHaveBeenCalledWith(
    { contactId: contacts[0].contactId },
    {
      baseUrl: 'http://localhost:4101/projects-api',
      correlationId: expect.any(String),
      idempotencyKey: expect.any(String),
      locale: 'en',
    },
  );
  await waitFor(() => expect(getContactListMock).toHaveBeenCalledTimes(2));

  await user.click(unarchiveButton);
  expect(unarchiveContactMock).toHaveBeenCalledWith(
    { contactId: archivedContact.contactId },
    {
      baseUrl: 'http://localhost:4101/projects-api',
      correlationId: expect.any(String),
      idempotencyKey: expect.any(String),
      locale: 'en',
    },
  );
  await waitFor(() => expect(getContactListMock).toHaveBeenCalledTimes(3));
});

test('uses one localized unavailable value for every null business field', async () => {
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  await screen.findByRole('heading', { name: activeCustomer.name });
  const list = getDescriptionList();
  expect(within(list).getAllByText('Not available')).toHaveLength(5);
  expect(list?.querySelectorAll('time')).toHaveLength(2);
});

test('formats date-only values by locale without shifting the calendar day', () => {
  expect(formatCustomerDateOnly('2026-01-01', 'en')).toBe('Jan 1, 2026');
  expect(formatCustomerDateOnly('2026-01-01', 'cs')).toBe('1. 1. 2026');
});

test('keeps a semantic busy announcement and stable detail-row skeleton while loading', () => {
  getCustomerDetailMock.mockReturnValue(Effect.never);
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  expect(screen.getByRole('status').textContent).toBe('Loading Customer details…');
  expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(document.querySelectorAll('dt')).toHaveLength(9);
  expect(screen.getByTestId('customer-detail-results').getAttribute('aria-live')).toBe('polite');
  expect(getContactListMock).not.toHaveBeenCalled();
});

test('preserves final Contact table geometry while the Contact query is loading', async () => {
  getContactListMock.mockReturnValue(Effect.never);
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  await screen.findByRole('heading', { name: activeCustomer.name });
  expect(screen.getByRole('status').textContent).toBe('Loading Contacts…');
  const table = screen.getByRole('table', { name: 'Customer Contacts' });
  expect(table.getAttribute('aria-busy')).toBe('true');
  expect(within(table).getAllByRole('row')).toHaveLength(4);
  expect(table.querySelectorAll('td')).toHaveLength(15);
});

test('renders the empty Contact table without data rows', async () => {
  getContactListMock.mockReturnValue(Effect.succeed({ items: [], nextOffset: null }));
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  const table = await waitFor(() => {
    const currentTable = screen.getByRole('table', { name: 'Customer Contacts' });
    expect(currentTable.querySelectorAll('tbody tr')).toHaveLength(0);
    return currentTable;
  });
  expect(within(table).getAllByRole('row')).toHaveLength(1);
  const emptyDescription = screen.getByText('No Contacts match this filter.');
  expect(emptyDescription.className).toContain('projects:sr-only');
  expect(table.getAttribute('aria-describedby')).toBe(emptyDescription.id);
  expect(screen.getByRole('link', { name: 'Create Contact' }).getAttribute('href')).toBe(
    `/en/projects/customers/${activeCustomer.customerId}/contacts/new`,
  );
});

test('renders Czech archived data and preserves the active locale in the return link', async () => {
  localeState.current = 'cs';
  getCustomerDetailMock.mockReturnValue(Effect.succeed(archivedCustomer));
  render(<CustomerDetailPage routeParams={{ id: archivedCustomer.customerId }} />);

  expect(await screen.findByRole('heading', { name: archivedCustomer.name })).toBeTruthy();
  expect(screen.getByText('Archivovaný')).toBeTruthy();
  expect(screen.getByText('00123456')).toBeTruthy();
  expect(screen.getByText('1. 1. 2026')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Zpět' }).getAttribute('href')).toBe(
    '/cs/projects/customers',
  );
  expect(screen.getAllByRole('link', { name: 'Upravit' })[0]?.getAttribute('href')).toBe(
    `/cs/projects/customers/${archivedCustomer.customerId}/edit`,
  );
  expect(await screen.findByRole('heading', { name: 'Kontakty' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Vytvořit kontakt' }).getAttribute('href')).toBe(
    `/cs/projects/customers/${archivedCustomer.customerId}/contacts/new`,
  );
  expect(screen.getByRole('combobox', { name: 'Stav kontaktu' })).toBeTruthy();
  expect(screen.getByRole('table', { name: 'Kontakty zákazníka' })).toBeTruthy();
  expect(screen.getAllByRole('link', { name: 'Upravit' })).toHaveLength(3);
  expect(screen.getAllByRole('button', { name: 'Archivovat' })).toHaveLength(2);
  expect(getContactListMock).toHaveBeenCalledWith(
    expect.any(Object),
    expect.objectContaining({ locale: 'cs' }),
  );
});

test('navigates Contact pages while retaining status and unrelated query state', async () => {
  searchState.current = '?view=compact&status=active';
  getContactListMock.mockReturnValue(
    Effect.succeed({ items: [contacts[0]], nextOffset: CONTACT_LIST_PAGE_SIZE }),
  );
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Next' }).getAttribute('href')).toBe(
    `/en/projects/customers/${activeCustomer.customerId}?view=compact&status=active&offset=25`,
  );
});

test('navigates to the previous Contact page and removes the zero offset', async () => {
  searchState.current = '?view=compact&status=archived&offset=25';
  getContactListMock.mockReturnValue(
    Effect.succeed({ items: [archivedContact], nextOffset: null }),
  );
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  await screen.findByRole('button', { name: 'Unarchive' });
  expect(screen.getByRole('link', { name: 'Previous' }).getAttribute('href')).toBe(
    `/en/projects/customers/${activeCustomer.customerId}?view=compact&status=archived`,
  );
});

test('filters Contacts by status and resets pagination to the first page', async () => {
  searchState.current = '?view=compact&status=active&offset=50';
  const user = userEvent.setup();
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
  const filter = screen.getByRole('combobox', { name: 'Contact status' });
  filter.focus();
  await user.keyboard('{Enter}{ArrowDown}{Enter}');
  expect(navigateMock).toHaveBeenCalledWith({
    to: `/en/projects/customers/${activeCustomer.customerId}?view=compact&status=archived`,
  });
});

test('reloads Contact data when returning to a previously shown status', async () => {
  let activeRequestCount = 0;
  getContactListMock.mockImplementation(
    (payload: { readonly filter: 'active' | 'archived' | 'all' }) => {
      if (payload.filter === 'archived') {
        return Effect.succeed({ items: [archivedContact], nextOffset: null });
      }
      activeRequestCount += 1;
      return Effect.succeed({
        items: [activeRequestCount === 1 ? contacts[0] : contacts[1]],
        nextOffset: null,
      });
    },
  );
  const user = userEvent.setup();
  const rendered = render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
  const activeFilter = screen.getByRole('combobox', { name: 'Contact status' });
  activeFilter.focus();
  await user.keyboard('{Enter}{ArrowDown}{Enter}');
  searchState.current = '?status=archived';
  rendered.rerender(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);
  await screen.findByRole('button', { name: 'Unarchive' });

  const archivedFilter = screen.getByRole('combobox', { name: 'Contact status' });
  archivedFilter.focus();
  await user.keyboard('{Enter}{ArrowUp}{Enter}');
  searchState.current = '?status=active';
  rendered.rerender(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  expect(await screen.findByText('Grace Hopper')).toBeTruthy();
  expect(getContactListMock).toHaveBeenCalledTimes(3);
});

test('reads fresh Contact pagination when the route Customer and query string change', async () => {
  const nextCustomerId = '44444444-4444-4444-8444-444444444444';
  searchState.current = '?status=active&offset=25';
  getContactListMock.mockImplementation(
    (payload: { readonly customerId: string; readonly offset: number }) =>
      Effect.succeed({
        items: [contacts[payload.offset === 0 ? 0 : 1]],
        nextOffset: payload.offset === 0 ? CONTACT_LIST_PAGE_SIZE : null,
      }),
  );
  const rendered = render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  expect(await screen.findByText('Grace Hopper')).toBeTruthy();
  searchState.current = '';
  rendered.rerender(<CustomerDetailPage routeParams={{ id: nextCustomerId }} />);
  await waitFor(() =>
    expect(getContactListMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ customerId: nextCustomerId, offset: 0 }),
      expect.any(Object),
    ),
  );
});

test.each([
  ['ContactListNotFoundProblem', 'The Customer for this Contact list no longer exists.', false],
  [
    'ContactListForbiddenProblem',
    'You do not have permission to view this Customer’s Contacts.',
    false,
  ],
  [
    'ContactListAuthenticationProblem',
    'Your session has expired. Sign in and load the Contacts again.',
    true,
  ],
  ['ContactListUnavailableProblem', 'The Contacts are temporarily unavailable. Try again.', true],
] as const)('maps Contact failure %s to its explicit state', async (tag, message, retryable) => {
  getContactListMock.mockReturnValue(Effect.fail({ _tag: tag }));
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  expect(await screen.findByText(message)).toBeTruthy();
  const contactsResults = screen.getByTestId('customer-contacts-results');
  expect(within(contactsResults).getByRole('status').textContent).toBe(message);
  expect(within(contactsResults).queryByRole('button', { name: 'Try again' }) !== null).toBe(
    retryable,
  );
});

test.each([
  [
    { _tag: 'HttpClientError', reason: { _tag: 'TransportError' } },
    'The Contacts could not be reached. Check your connection and try again.',
  ],
  [
    { _tag: 'HttpClientError', reason: { _tag: 'EmptyBodyError' } },
    'The Contact list response could not be read. Try again.',
  ],
  [{ _tag: 'SchemaError' }, 'The Contact list response could not be read. Try again.'],
  [{ _tag: 'ContactListInternalProblem' }, 'The Contacts could not be loaded safely. Try again.'],
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Rstest parameterized cases use callbacks.
] as const)('renders a retryable localized Contact client failure', async (error, message) => {
  getContactListMock.mockReturnValue(Effect.fail(error));
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  const results = await screen.findByTestId('customer-contacts-results');
  expect(await within(results).findByText(message)).toBeTruthy();
  expect(within(results).getByRole('button', { name: 'Try again' })).toBeTruthy();
});

test('retries Contact authentication failure from the keyboard and restores result focus', async () => {
  getContactListMock
    .mockReturnValueOnce(Effect.fail({ _tag: 'ContactListAuthenticationProblem' }))
    .mockReturnValueOnce(Effect.succeed({ items: contacts, nextOffset: null }));
  const user = userEvent.setup();
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  const contactsResults = await screen.findByTestId('customer-contacts-results');
  const retry = await within(contactsResults).findByRole('button', { name: 'Try again' });
  retry.focus();
  await user.keyboard('{Enter}');
  expect(await within(contactsResults).findByText('Ada Lovelace')).toBeTruthy();
  expect(getContactListMock).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(document.activeElement).toBe(contactsResults));
});

test.each([
  ['CustomerDetailNotFoundProblem', 'This Customer could not be found.', false],
  ['CustomerDetailForbiddenProblem', 'You do not have permission to view this Customer.', false],
  [
    'CustomerDetailAuthenticationProblem',
    'Your session has expired. Try again after signing in.',
    true,
  ],
  ['CustomerDetailUnavailableProblem', 'The Customer is temporarily unavailable. Try again.', true],
] as const)('maps %s to its explicit presentation state', async (tag, message, retryable) => {
  getCustomerDetailMock.mockReturnValue(Effect.fail({ _tag: tag }));
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe(message);
  expect(screen.queryByRole('button', { name: 'Try again' }) !== null).toBe(retryable);
});

test('retries an unavailable request from the keyboard, keeps the failure visible, and restores focus', async () => {
  getCustomerDetailMock
    .mockReturnValueOnce(Effect.fail({ _tag: 'CustomerDetailUnavailableProblem' }))
    .mockReturnValueOnce(Effect.succeed(activeCustomer));
  const user = userEvent.setup();
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  const retry = await screen.findByRole('button', { name: 'Try again' });
  retry.focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('heading', { name: activeCustomer.name })).toBeTruthy();
  expect(getCustomerDetailMock).toHaveBeenCalledTimes(2);
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByTestId('customer-detail-results')),
  );
});

test('maps every remaining client failure family without exposing raw errors', () => {
  expect(classifyCustomerDetailError({ _tag: 'CustomerDetailNotFoundProblem' })).toEqual({
    state: 'not_found',
  });
  expect(classifyCustomerDetailError({ _tag: 'CustomerDetailInvalidProblem' })).toEqual({
    state: 'not_found',
  });
  expect(classifyCustomerDetailError({ _tag: 'GatewayForbiddenProblem' })).toEqual({
    state: 'forbidden',
  });
  expect(classifyCustomerDetailError({ _tag: 'SchemaError' })).toEqual({
    reason: 'decode',
    state: 'unavailable',
  });
  expect(
    classifyCustomerDetailError({
      _tag: 'HttpClientError',
      reason: { _tag: 'TransportError' },
    }),
  ).toEqual({ reason: 'transport', state: 'unavailable' });
  for (const tag of [
    'CustomerDetailInternalProblem',
    'GatewayAudienceInvalidProblem',
    'GatewayInternalProblem',
  ] as const) {
    expect(classifyCustomerDetailError({ _tag: tag })).toEqual({
      reason: 'internal',
      state: 'unavailable',
    });
  }
});

test('maps the complete Contact list client failure union without leaking diagnostics', () => {
  expect(classifyContactListError({ _tag: 'ContactListNotFoundProblem' })).toEqual({
    state: 'parent_not_found',
  });
  for (const tag of ['ContactListForbiddenProblem', 'GatewayForbiddenProblem'] as const) {
    expect(classifyContactListError({ _tag: tag })).toEqual({ state: 'forbidden' });
  }
  for (const tag of [
    'ContactListAuthenticationProblem',
    'GatewayAuthenticationRequiredProblem',
  ] as const) {
    expect(classifyContactListError({ _tag: tag })).toEqual({
      state: 'authentication_expired',
    });
  }
  for (const tag of [
    'ContactListUnavailableProblem',
    'GatewayRateLimitedProblem',
    'GatewayUnavailableProblem',
  ] as const) {
    expect(classifyContactListError({ _tag: tag })).toEqual({
      reason: 'backend',
      state: 'unavailable',
    });
  }
  for (const tag of [
    'ContactListInvalidProblem',
    'ContactListInternalProblem',
    'GatewayAudienceInvalidProblem',
    'GatewayInternalProblem',
  ] as const) {
    expect(classifyContactListError({ _tag: tag })).toEqual({
      reason: 'internal',
      state: 'unavailable',
    });
  }
  expect(classifyContactListError({ _tag: 'SchemaError' })).toEqual({
    reason: 'decode',
    state: 'unavailable',
  });
  for (const [reason, expected] of [
    ['TransportError', 'transport'],
    ['DecodeError', 'decode'],
    ['EmptyBodyError', 'decode'],
    ['UnexpectedStatus', 'internal'],
  ] as const) {
    expect(classifyContactListError({ _tag: 'HttpClientError', reason: { _tag: reason } })).toEqual(
      { reason: expected, state: 'unavailable' },
    );
  }
});

test('keeps locale parity and the page source on the generated frontend seam', () => {
  expect(flattenKeys(csCatalog.projects.pages.customerDetail)).toEqual(
    flattenKeys(enCatalog.projects.pages.customerDetail),
  );
  const source = readFileSync(
    new URL('../../src/routes/[lang]/projects/customers/[id]/page.tsx', import.meta.url),
    'utf-8',
  );
  expect(source).toContain("from '../../../../../api/projects-client.ts'");
  expect(source).not.toMatch(/\bfetch\s*\(/u);
  expect(source).not.toMatch(
    /contact-list-read-server|customer-detail-read-server|executeContactList|src\/db|CustomerDetailApi/u,
  );
  expect(source).not.toContain('HttpApiEndpoint');
});
