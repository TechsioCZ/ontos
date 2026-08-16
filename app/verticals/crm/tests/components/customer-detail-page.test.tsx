import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect } from 'effect';
import type { AnchorHTMLAttributes } from 'react';
import csCatalog from '../../locales/cs/crm.json';
import enCatalog from '../../locales/en/crm.json';
import {
  CustomerDetailPage,
  classifyCustomerDetailError,
  customerDetailQueryKey,
  decodeCustomerDetailId,
} from '../../src/routes/[lang]/crm/customers/[id]/page.tsx';

Object.assign(globalThis, {
  ULTRAMODERN_CRM_API_BASE_URL: 'http://localhost:4101/crm-api',
});

const { getCustomerDetailMock, localeState, runEffectRequestMock } = rstest.hoisted(() => ({
  getCustomerDetailMock: rstest.fn(),
  localeState: { current: 'en' as 'cs' | 'en' },
  runEffectRequestMock: rstest.fn(),
}));

const translations = {
  cs: {
    'crm.pages.customerDetail.back': 'Zpět na zákazníky',
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
    'crm.pages.customerDetail.back': 'Back to Customers',
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
}));

rstest.mock('../../src/api/crm-client.ts', () => ({
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

const flattenKeys = (value: object, prefix = ''): string[] =>
  Object.entries(value)
    .flatMap(([key, child]) => {
      const path = prefix.length === 0 ? key : `${prefix}.${key}`;
      return typeof child === 'object' && child !== null ? flattenKeys(child, path) : [path];
    })
    .sort();

beforeEach(() => {
  localeState.current = 'en';
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
  });

  test.each([undefined, 'customer-1', 'x'.repeat(201)])(
    'maps invalid route ID %s to not found without invoking the BFF client',
    async (id) => {
      render(<CustomerDetailPage routeParams={id === undefined ? {} : { id }} />);

      expect(await screen.findByText('This Customer could not be found.')).toBeTruthy();
      expect(getCustomerDetailMock).not.toHaveBeenCalled();
      expect(runEffectRequestMock).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    },
  );
});

test('loads one Customer once through the typed CRM client with the exact URL ID', async () => {
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  await screen.findByRole('heading', { name: activeCustomer.name });
  expect(getCustomerDetailMock).toHaveBeenCalledTimes(1);
  expect(getCustomerDetailMock).toHaveBeenCalledWith(
    { customerId: activeCustomer.customerId },
    {
      baseUrl: 'http://localhost:4101/crm-api',
      correlationId: expect.any(String),
      locale: 'en',
    },
  );
  expect(runEffectRequestMock).toHaveBeenCalledTimes(1);
});

test('renders the link, heading, semantic overview, lifecycle, and ISO time values', async () => {
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
  expect(document.querySelector('table')).toBeNull();
  expect(document.querySelector('[role="tablist"]')).toBeNull();
});

test('keeps a semantic busy announcement and stable detail-row skeleton while loading', () => {
  getCustomerDetailMock.mockReturnValue(Effect.never);
  render(<CustomerDetailPage routeParams={{ id: activeCustomer.customerId }} />);

  expect(screen.getByRole('status').textContent).toBe('Loading Customer details…');
  expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(document.querySelectorAll('dt')).toHaveLength(4);
  expect(screen.getByTestId('customer-detail-results').getAttribute('aria-live')).toBe('polite');
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
    'CustomerDetailInvalidProblem',
    'GatewayAudienceInvalidProblem',
    'GatewayInternalProblem',
  ] as const) {
    expect(classifyCustomerDetailError({ _tag: tag } as never)).toEqual({
      reason: 'internal',
      state: 'unavailable',
    });
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
  expect(source).not.toMatch(/customer-detail-read-server|src\/db|CustomerDetailApi/u);
  expect(source).not.toContain('HttpApiEndpoint');
});
