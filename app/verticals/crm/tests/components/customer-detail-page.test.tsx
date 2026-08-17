// @effect-diagnostics asyncFunction:off anyUnknownInErrorContext:off nodeBuiltinImport:off
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect } from 'effect';
import type { AnchorHTMLAttributes } from 'react';
import csCatalog from '../../locales/cs/crm.json';
import enCatalog from '../../locales/en/crm.json';
import StandaloneCustomerDetailPage, {
  CONTACT_LIST_PAGE_SIZE,
  CustomerDetailPage,
  classifyContactListError,
  classifyCustomerDetailError,
  contactListQueryKey,
  customerDetailQueryKey,
  decodeCustomerDetailId,
} from '../../src/routes/[lang]/crm/customers/[id]/page.tsx';

Object.assign(globalThis, {
  ULTRAMODERN_CRM_API_BASE_URL: 'http://localhost:4101/crm-api',
});

const {
  getContactListMock,
  getCustomerDetailMock,
  localeState,
  routeParamsState,
  runEffectRequestMock,
} = rstest.hoisted(() => ({
  getContactListMock: rstest.fn(),
  getCustomerDetailMock: rstest.fn(),
  localeState: { current: 'en' as 'cs' | 'en' },
  routeParamsState: { current: {} as Readonly<Partial<Record<'id', string>>> },
  runEffectRequestMock: rstest.fn(),
}));

const translations = {
  cs: {
    'crm.pages.contactCreate.title': 'Vytvořit kontakt',
    'crm.pages.contactEdit.title': 'Upravit kontakt',
    'crm.pages.customerDetail.back': 'Zpět na zákazníky',
    'crm.pages.customerDetail.contacts.heading': 'Kontakty',
    'crm.pages.customerDetail.contacts.pagination.label': 'Stránky kontaktů zákazníka',
    'crm.pages.customerDetail.contacts.pagination.next': 'Další',
    'crm.pages.customerDetail.contacts.pagination.previous': 'Předchozí',
    'crm.pages.customerDetail.contacts.states.authenticationExpired':
      'Vaše relace vypršela. Po přihlášení načtěte kontakty znovu.',
    'crm.pages.customerDetail.contacts.states.decode':
      'Odpověď se seznamem kontaktů se nepodařilo přečíst. Zkuste to znovu.',
    'crm.pages.customerDetail.contacts.states.empty': 'Tento zákazník nemá žádné aktivní kontakty.',
    'crm.pages.customerDetail.contacts.states.forbidden':
      'Nemáte oprávnění zobrazit kontakty tohoto zákazníka.',
    'crm.pages.customerDetail.contacts.states.internal':
      'Kontakty se nepodařilo bezpečně načíst. Zkuste to znovu.',
    'crm.pages.customerDetail.contacts.states.loading': 'Načítání kontaktů…',
    'crm.pages.customerDetail.contacts.states.parentNotFound':
      'Zákazník pro tento seznam kontaktů již neexistuje.',
    'crm.pages.customerDetail.contacts.states.retry': 'Zkusit znovu',
    'crm.pages.customerDetail.contacts.states.retrying': 'Opakování…',
    'crm.pages.customerDetail.contacts.states.transport':
      'Kontakty nejsou dostupné. Zkontrolujte připojení a zkuste to znovu.',
    'crm.pages.customerDetail.contacts.states.unavailable':
      'Kontakty jsou dočasně nedostupné. Zkuste to znovu.',
    'crm.pages.customerDetail.contacts.table.actions': 'Akce',
    'crm.pages.customerDetail.contacts.table.caption': 'Aktivní kontakty zákazníka',
    'crm.pages.customerDetail.contacts.table.email': 'E-mail',
    'crm.pages.customerDetail.contacts.table.name': 'Jméno',
    'crm.pages.customerDetail.contacts.table.phone': 'Telefon',
    'crm.pages.customerDetail.fields.createdAt': 'Vytvořeno',
    'crm.pages.customerDetail.fields.customerId': 'ID zákazníka',
    'crm.pages.customerDetail.fields.status': 'Stav',
    'crm.pages.customerDetail.fields.updatedAt': 'Aktualizováno',
    'crm.pages.customerDetail.lifecycle.active': 'Aktivní',
    'crm.pages.customerDetail.lifecycle.archived': 'Archivovaný',
    'crm.pages.customerDetail.states.authenticationExpired':
      'Vaše relace vypršela. Po přihlášení to zkuste znovu.',
    'crm.pages.customerDetail.states.decode':
      'Odpověď s údaji zákazníka se nepodařilo přečíst. Zkuste to znovu.',
    'crm.pages.customerDetail.states.forbidden': 'Nemáte oprávnění zobrazit tohoto zákazníka.',
    'crm.pages.customerDetail.states.internal':
      'Zákazníka se nepodařilo bezpečně načíst. Zkuste to znovu.',
    'crm.pages.customerDetail.states.loading': 'Načítání údajů zákazníka…',
    'crm.pages.customerDetail.states.notFound': 'Tohoto zákazníka se nepodařilo najít.',
    'crm.pages.customerDetail.states.retry': 'Zkusit znovu',
    'crm.pages.customerDetail.states.retrying': 'Opakování…',
    'crm.pages.customerDetail.states.transport':
      'Zákazník není dostupný. Zkontrolujte připojení a zkuste to znovu.',
    'crm.pages.customerDetail.states.unavailable':
      'Zákazník je dočasně nedostupný. Zkuste to znovu.',
    'crm.pages.customerDetail.title': 'Detail zákazníka',
  },
  en: {
    'crm.pages.contactCreate.title': 'Create Contact',
    'crm.pages.contactEdit.title': 'Edit Contact',
    'crm.pages.customerDetail.back': 'Back to Customers',
    'crm.pages.customerDetail.contacts.heading': 'Contacts',
    'crm.pages.customerDetail.contacts.pagination.label': 'Customer Contact pages',
    'crm.pages.customerDetail.contacts.pagination.next': 'Next',
    'crm.pages.customerDetail.contacts.pagination.previous': 'Previous',
    'crm.pages.customerDetail.contacts.states.authenticationExpired':
      'Your session has expired. Sign in and load the Contacts again.',
    'crm.pages.customerDetail.contacts.states.decode':
      'The Contact list response could not be read. Try again.',
    'crm.pages.customerDetail.contacts.states.empty': 'This Customer has no active Contacts.',
    'crm.pages.customerDetail.contacts.states.forbidden':
      'You do not have permission to view this Customer’s Contacts.',
    'crm.pages.customerDetail.contacts.states.internal':
      'The Contacts could not be loaded safely. Try again.',
    'crm.pages.customerDetail.contacts.states.loading': 'Loading Contacts…',
    'crm.pages.customerDetail.contacts.states.parentNotFound':
      'The Customer for this Contact list no longer exists.',
    'crm.pages.customerDetail.contacts.states.retry': 'Try again',
    'crm.pages.customerDetail.contacts.states.retrying': 'Trying again…',
    'crm.pages.customerDetail.contacts.states.transport':
      'The Contacts could not be reached. Check your connection and try again.',
    'crm.pages.customerDetail.contacts.states.unavailable':
      'The Contacts are temporarily unavailable. Try again.',
    'crm.pages.customerDetail.contacts.table.actions': 'Actions',
    'crm.pages.customerDetail.contacts.table.caption': 'Active Customer Contacts',
    'crm.pages.customerDetail.contacts.table.email': 'Email',
    'crm.pages.customerDetail.contacts.table.name': 'Name',
    'crm.pages.customerDetail.contacts.table.phone': 'Phone',
    'crm.pages.customerDetail.fields.createdAt': 'Created',
    'crm.pages.customerDetail.fields.customerId': 'Customer ID',
    'crm.pages.customerDetail.fields.status': 'Status',
    'crm.pages.customerDetail.fields.updatedAt': 'Updated',
    'crm.pages.customerDetail.lifecycle.active': 'Active',
    'crm.pages.customerDetail.lifecycle.archived': 'Archived',
    'crm.pages.customerDetail.states.authenticationExpired':
      'Your session has expired. Try again after signing in.',
    'crm.pages.customerDetail.states.decode': 'The Customer response could not be read. Try again.',
    'crm.pages.customerDetail.states.forbidden':
      'You do not have permission to view this Customer.',
    'crm.pages.customerDetail.states.internal':
      'The Customer could not be loaded safely. Try again.',
    'crm.pages.customerDetail.states.loading': 'Loading Customer details…',
    'crm.pages.customerDetail.states.notFound': 'This Customer could not be found.',
    'crm.pages.customerDetail.states.retry': 'Try again',
    'crm.pages.customerDetail.states.retrying': 'Trying again…',
    'crm.pages.customerDetail.states.transport':
      'The Customer could not be reached. Check your connection and try again.',
    'crm.pages.customerDetail.states.unavailable':
      'The Customer is temporarily unavailable. Try again.',
    'crm.pages.customerDetail.title': 'Customer detail',
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
  useParams: () => routeParamsState.current,
}));

rstest.mock('../../src/api/crm-client.ts', () => ({
  getContactList: getContactListMock,
  getCustomerDetail: getCustomerDetailMock,
  runEffectRequest: runEffectRequestMock,
}));

rstest.mock('../../src/routes/ultramodern-route-head.tsx', () => ({
  UltramodernRouteHead: () => null,
}));

const activeCustomer = {
  archivedAt: null,
  createdAt: '2026-08-13T08:15:00.000Z',
  customerId: '11111111-1111-4111-8111-111111111111',
  name: 'Acme Property Group',
  updatedAt: '2026-08-14T09:30:00.000Z',
} as const;

const archivedCustomer = {
  ...activeCustomer,
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

const flattenKeys = (value: object, prefix = ''): string[] =>
  Object.entries(value)
    .flatMap(([key, child]) => {
      const path = prefix.length === 0 ? key : `${prefix}.${key}`;
      return typeof child === 'object' && child !== null ? flattenKeys(child, path) : [path];
    })
    .sort();

beforeEach(() => {
  localeState.current = 'en';
  routeParamsState.current = {};
  getContactListMock.mockReturnValue(Effect.succeed({ items: contacts, nextOffset: null }));
  getCustomerDetailMock.mockReturnValue(Effect.succeed(activeCustomer));
  runEffectRequestMock.mockImplementation((effect: Effect.Effect<unknown, unknown>) =>
    Effect.runPromise(effect),
  );
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
    expect(await screen.findByRole('table', { name: 'Active Customer Contacts' })).toBeTruthy();
  });

  test('accepts only a bounded Customer UUID and builds an ID-specific query key', () => {
    expect(decodeCustomerDetailId(activeCustomer.customerId)).toBe(activeCustomer.customerId);
    for (const value of [undefined, '', 'customer-1', 'x'.repeat(201)]) {
      expect(decodeCustomerDetailId(value)).toBeUndefined();
    }
    expect(customerDetailQueryKey(activeCustomer.customerId)).toEqual([
      'crm',
      'customers',
      'detail',
      activeCustomer.customerId,
    ]);
    expect(contactListQueryKey(activeCustomer.customerId, 25)).toEqual([
      'crm',
      'customers',
      activeCustomer.customerId,
      'contacts',
      { limit: CONTACT_LIST_PAGE_SIZE, offset: 25 },
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

test('loads the Customer and its active Contacts through the typed CRM client with exact BFF options', async () => {
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  await screen.findByRole('heading', { name: activeCustomer.name });
  await screen.findByRole('table', { name: 'Active Customer Contacts' });
  expect(getCustomerDetailMock).toHaveBeenCalledTimes(1);
  expect(getCustomerDetailMock).toHaveBeenCalledWith(
    { customerId: activeCustomer.customerId },
    {
      baseUrl: 'http://localhost:4101/crm-api',
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
      baseUrl: 'http://localhost:4101/crm-api',
      correlationId: expect.any(String),
      locale: 'en',
    },
  );
  expect(runEffectRequestMock).toHaveBeenCalledTimes(2);
});

test('renders the Customer overview followed by ordered semantic Contact rows', async () => {
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  await screen.findByRole('heading', { name: activeCustomer.name });
  expect(screen.getByRole('link', { name: 'Back to Customers' }).getAttribute('href')).toBe(
    '/en/crm/customers',
  );
  const list = document.querySelector('dl');
  expect(list).not.toBeNull();
  expect(within(list as HTMLElement).getByText('Customer ID')).toBeTruthy();
  expect(within(list as HTMLElement).getByText(activeCustomer.customerId)).toBeTruthy();
  expect(within(list as HTMLElement).getByText('Active')).toBeTruthy();
  const times = list?.querySelectorAll('time');
  expect(times).toHaveLength(2);
  expect(times?.[0]?.getAttribute('datetime')).toBe(activeCustomer.createdAt);
  expect(times?.[1]?.getAttribute('datetime')).toBe(activeCustomer.updatedAt);
  const contactsHeading = await screen.findByRole('heading', { name: 'Contacts' });
  const table = screen.getByRole('table', { name: 'Active Customer Contacts' });
  expect(contactsHeading.compareDocumentPosition(table)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent),
  ).toEqual(['Name', 'Email', 'Phone', 'Actions']);
  const rows = within(table).getAllByRole('row');
  expect(rows).toHaveLength(3);
  expect(
    within(rows[1] as HTMLElement)
      .getAllByRole('cell')
      .map((cell) => cell.textContent),
  ).toEqual(['Ada Lovelace', 'ada@example.com', '+420 111 222 333', 'Edit Contact']);
  expect(
    within(rows[1] as HTMLElement)
      .getByRole('link', { name: 'Ada Lovelace' })
      .getAttribute('href'),
  ).toBe(`/en/crm/customers/${activeCustomer.customerId}/contacts/${contacts[0].contactId}`);
  expect(
    within(rows[1] as HTMLElement)
      .getByRole('link', { name: 'Edit Contact' })
      .getAttribute('href'),
  ).toBe(`/en/crm/customers/${activeCustomer.customerId}/contacts/${contacts[0].contactId}/edit`);
  expect(
    within(rows[2] as HTMLElement)
      .getAllByRole('cell')
      .map((cell) => cell.textContent),
  ).toEqual(['Grace Hopper', 'grace@example.com', '+420 444 555 666', 'Edit Contact']);
  expect(screen.getByTestId('customer-contacts-table-overflow').className).toContain(
    'crm:overflow-x-auto',
  );
  expect(document.querySelector('[role="tablist"]')).toBeNull();
});

test('keeps a semantic busy announcement and stable detail-row skeleton while loading', () => {
  getCustomerDetailMock.mockReturnValue(Effect.never);
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  expect(screen.getByRole('status').textContent).toBe('Loading Customer details…');
  expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(document.querySelectorAll('dt')).toHaveLength(4);
  expect(screen.getByTestId('customer-detail-results').getAttribute('aria-live')).toBe('polite');
  expect(getContactListMock).not.toHaveBeenCalled();
});

test('preserves final Contact table geometry while the Contact query is loading', async () => {
  getContactListMock.mockReturnValue(Effect.never);
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  await screen.findByRole('heading', { name: activeCustomer.name });
  expect(screen.getByRole('status').textContent).toBe('Loading Contacts…');
  const table = screen.getByRole('table', { name: 'Active Customer Contacts' });
  expect(table.getAttribute('aria-busy')).toBe('true');
  expect(within(table).getAllByRole('row')).toHaveLength(4);
  expect(table.querySelectorAll('td')).toHaveLength(12);
});

test('renders the empty Contact table without data rows', async () => {
  getContactListMock.mockReturnValue(Effect.succeed({ items: [], nextOffset: null }));
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  const table = await waitFor(() => {
    const currentTable = screen.getByRole('table', { name: 'Active Customer Contacts' });
    expect(currentTable.querySelectorAll('tbody tr')).toHaveLength(0);
    return currentTable;
  });
  expect(within(table).getAllByRole('row')).toHaveLength(1);
  const emptyDescription = screen.getByText('This Customer has no active Contacts.');
  expect(emptyDescription.className).toContain('crm:sr-only');
  expect(table.getAttribute('aria-describedby')).toBe(emptyDescription.id);
  expect(screen.getByRole('link', { name: 'Create Contact' }).getAttribute('href')).toBe(
    `/en/crm/customers/${activeCustomer.customerId}/contacts/new`,
  );
});

test('renders Czech archived data and preserves the active locale in the return link', async () => {
  localeState.current = 'cs';
  getCustomerDetailMock.mockReturnValue(Effect.succeed(archivedCustomer));
  render(<CustomerDetailPage routeParams={{ id: archivedCustomer.customerId }} />);

  expect(await screen.findByRole('heading', { name: archivedCustomer.name })).toBeTruthy();
  expect(screen.getByText('Archivovaný')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Zpět na zákazníky' }).getAttribute('href')).toBe(
    '/cs/crm/customers',
  );
  expect(await screen.findByRole('heading', { name: 'Kontakty' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Vytvořit kontakt' }).getAttribute('href')).toBe(
    `/cs/crm/customers/${archivedCustomer.customerId}/contacts/new`,
  );
  expect(screen.getByRole('table', { name: 'Aktivní kontakty zákazníka' })).toBeTruthy();
  expect(getContactListMock).toHaveBeenCalledWith(
    expect.any(Object),
    expect.objectContaining({ locale: 'cs' }),
  );
});

test('pages active Contacts without mixing cached offsets', async () => {
  getContactListMock
    .mockReturnValueOnce(
      Effect.succeed({ items: [contacts[0]], nextOffset: CONTACT_LIST_PAGE_SIZE }),
    )
    .mockReturnValueOnce(Effect.succeed({ items: [contacts[1]], nextOffset: null }));
  const user = userEvent.setup();
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByText('Grace Hopper')).toBeTruthy();
  expect(screen.queryByText('Ada Lovelace')).toBeNull();
  expect(getContactListMock).toHaveBeenLastCalledWith(
    {
      customerId: activeCustomer.customerId,
      filter: 'active',
      limit: CONTACT_LIST_PAGE_SIZE,
      offset: CONTACT_LIST_PAGE_SIZE,
    },
    expect.objectContaining({ locale: 'en' }),
  );
  await user.click(screen.getByRole('button', { name: 'Previous' }));
  expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
  expect(getContactListMock).toHaveBeenCalledTimes(2);
});

test('resets Contact pagination when the route Customer changes', async () => {
  const nextCustomerId = '44444444-4444-4444-8444-444444444444';
  getContactListMock.mockImplementation(
    (payload: { readonly customerId: string; readonly offset: number }) =>
      Effect.succeed({
        items: [contacts[payload.offset === 0 ? 0 : 1]],
        nextOffset: payload.offset === 0 ? CONTACT_LIST_PAGE_SIZE : null,
      }),
  );
  const user = userEvent.setup();
  const rendered = render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  await user.click(await screen.findByRole('button', { name: 'Next' }));
  expect(await screen.findByText('Grace Hopper')).toBeTruthy();
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
  getContactListMock.mockReturnValue(Effect.fail({ _tag: tag } as never));
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
  getContactListMock.mockReturnValue(Effect.fail(error as never));
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  const results = await screen.findByTestId('customer-contacts-results');
  expect(await within(results).findByText(message)).toBeTruthy();
  expect(within(results).getByRole('button', { name: 'Try again' })).toBeTruthy();
});

test('retries Contact authentication failure from the keyboard and restores result focus', async () => {
  getContactListMock
    .mockReturnValueOnce(Effect.fail({ _tag: 'ContactListAuthenticationProblem' } as never))
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
  getCustomerDetailMock.mockReturnValue(Effect.fail({ _tag: tag } as never));
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe(message);
  expect(screen.queryByRole('button', { name: 'Try again' }) !== null).toBe(retryable);
});

test('retries an unavailable request from the keyboard, keeps the failure visible, and restores focus', async () => {
  getCustomerDetailMock
    .mockReturnValueOnce(Effect.fail({ _tag: 'CustomerDetailUnavailableProblem' } as never))
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
  expect(classifyCustomerDetailError({ _tag: 'CustomerDetailNotFoundProblem' } as never)).toEqual({
    state: 'not_found',
  });
  expect(classifyCustomerDetailError({ _tag: 'CustomerDetailInvalidProblem' } as never)).toEqual({
    state: 'not_found',
  });
  expect(classifyCustomerDetailError({ _tag: 'GatewayForbiddenProblem' } as never)).toEqual({
    state: 'forbidden',
  });
  expect(classifyCustomerDetailError({ _tag: 'SchemaError' } as never)).toEqual({
    reason: 'decode',
    state: 'unavailable',
  });
  expect(
    classifyCustomerDetailError({
      _tag: 'HttpClientError',
      reason: { _tag: 'TransportError' },
    } as never),
  ).toEqual({ reason: 'transport', state: 'unavailable' });
  for (const tag of [
    'CustomerDetailInternalProblem',
    'GatewayAudienceInvalidProblem',
    'GatewayInternalProblem',
  ] as const) {
    expect(classifyCustomerDetailError({ _tag: tag } as never)).toEqual({
      reason: 'internal',
      state: 'unavailable',
    });
  }
});

test('maps the complete Contact list client failure union without leaking diagnostics', () => {
  expect(classifyContactListError({ _tag: 'ContactListNotFoundProblem' } as never)).toEqual({
    state: 'parent_not_found',
  });
  for (const tag of ['ContactListForbiddenProblem', 'GatewayForbiddenProblem'] as const) {
    expect(classifyContactListError({ _tag: tag } as never)).toEqual({ state: 'forbidden' });
  }
  for (const tag of [
    'ContactListAuthenticationProblem',
    'GatewayAuthenticationRequiredProblem',
  ] as const) {
    expect(classifyContactListError({ _tag: tag } as never)).toEqual({
      state: 'authentication_expired',
    });
  }
  for (const tag of [
    'ContactListUnavailableProblem',
    'GatewayRateLimitedProblem',
    'GatewayUnavailableProblem',
  ] as const) {
    expect(classifyContactListError({ _tag: tag } as never)).toEqual({
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
    expect(classifyContactListError({ _tag: tag } as never)).toEqual({
      reason: 'internal',
      state: 'unavailable',
    });
  }
  expect(classifyContactListError({ _tag: 'SchemaError' } as never)).toEqual({
    reason: 'decode',
    state: 'unavailable',
  });
  for (const [reason, expected] of [
    ['TransportError', 'transport'],
    ['DecodeError', 'decode'],
    ['EmptyBodyError', 'decode'],
    ['UnexpectedStatus', 'internal'],
  ] as const) {
    expect(
      classifyContactListError({ _tag: 'HttpClientError', reason: { _tag: reason } } as never),
    ).toEqual({ reason: expected, state: 'unavailable' });
  }
});

test('keeps locale parity and the page source on the generated frontend seam', () => {
  expect(flattenKeys(csCatalog.crm.pages.customerDetail)).toEqual(
    flattenKeys(enCatalog.crm.pages.customerDetail),
  );
  const source = readFileSync(
    new URL('../../src/routes/[lang]/crm/customers/[id]/page.tsx', import.meta.url),
    'utf-8',
  );
  expect(source).toContain("from '../../../../../api/crm-client.ts'");
  expect(source).not.toMatch(/\bfetch\s*\(/u);
  expect(source).not.toMatch(
    /contact-list-read-server|customer-detail-read-server|executeContactList|src\/db|CustomerDetailApi/u,
  );
  expect(source).not.toContain('HttpApiEndpoint');
});
