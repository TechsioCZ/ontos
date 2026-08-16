import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, rstest, test } from '@rstest/core';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect } from 'effect';
import type { AnchorHTMLAttributes } from 'react';
import csCatalog from '../../locales/cs/crm.json';
import enCatalog from '../../locales/en/crm.json';
import {
  ContactDetailPage,
  classifyContactDetailError,
  contactDetailQueryKey,
  decodeContactDetailId,
  toContactDetailReadyModel,
} from '../../src/routes/[lang]/crm/customers/[id]/contacts/[contactId]/page.tsx';

Object.assign(globalThis, {
  ULTRAMODERN_CRM_API_BASE_URL: 'http://localhost:4101/crm-api',
});

const { getContactMock, localeState, runEffectRequestMock } = rstest.hoisted(() => ({
  getContactMock: rstest.fn(),
  localeState: { current: 'en' as 'cs' | 'en' },
  runEffectRequestMock: rstest.fn(),
}));

const catalogs = { cs: csCatalog, en: enCatalog } as const;
const translate = (language: 'cs' | 'en', key: string): string => {
  let value: unknown = catalogs[language];
  for (const segment of key.split('.')) {
    if (typeof value !== 'object' || value === null || !(segment in value)) {
      return key;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === 'string' ? value : key;
};

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    language: localeState.current,
    t: (key: string) => translate(localeState.current, key),
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
  getContact: getContactMock,
  runEffectRequest: runEffectRequestMock,
}));

rstest.mock('../../src/routes/ultramodern-route-head.tsx', () => ({
  UltramodernRouteHead: () => null,
}));

const customerId = '11111111-1111-4111-8111-111111111111';
const otherCustomerId = '22222222-2222-4222-8222-222222222222';
const contactId = '33333333-3333-4333-8333-333333333333';
const activeContact = {
  archivedAt: null,
  contactId,
  createdAt: '2026-08-13T08:15:00.000Z',
  customerId,
  email: 'ada.lovelace@example.test',
  name: 'Ada Lovelace',
  phone: '+420 777 123 456',
  updatedAt: '2026-08-14T09:30:00.000Z',
} as const;

const archivedContact = {
  ...activeContact,
  archivedAt: '2026-08-14T10:00:00.000Z',
  name: 'Archivovaný kontakt s úmyslně velmi dlouhým jménem',
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
  getContactMock.mockReturnValue(Effect.succeed(activeContact));
  runEffectRequestMock.mockImplementation((effect: Effect.Effect<unknown, unknown>) =>
    Effect.runPromise(effect),
  );
});

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

describe('Contact detail route input', () => {
  test('accepts only bounded CRM UUIDs and builds a hierarchical query key', () => {
    expect(decodeContactDetailId(customerId)).toBe(customerId);
    expect(decodeContactDetailId(contactId)).toBe(contactId);
    for (const value of [undefined, '', 'contact-1', 'x'.repeat(201)]) {
      expect(decodeContactDetailId(value)).toBeUndefined();
    }
    expect(contactDetailQueryKey(customerId, contactId)).toEqual([
      'crm',
      'customers',
      customerId,
      'contacts',
      'detail',
      contactId,
    ]);
  });

  test.each([
    [{ contactId }],
    [{ id: customerId }],
    [{ contactId, id: 'customer-1' }],
    [{ contactId: 'contact-1', id: customerId }],
    [{ contactId, id: 'x'.repeat(201) }],
  ])(
    'maps invalid parameter pair %j to not found without invoking the BFF client',
    async (routeParams) => {
      render(<ContactDetailPage routeParams={routeParams} />);

      expect(
        await screen.findByText('This Contact could not be found for the selected Customer.'),
      ).toBeTruthy();
      expect(getContactMock).not.toHaveBeenCalled();
      expect(runEffectRequestMock).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      if (!('id' in routeParams) || routeParams.id !== customerId) {
        expect(screen.queryByRole('link', { name: 'Back to Customer' })).toBeNull();
      }
    },
  );
});

test('loads one Contact once through the typed CRM client with only the Contact ID', async () => {
  render(<ContactDetailPage routeParams={{ contactId, id: customerId }} />);

  await screen.findByRole('heading', { name: activeContact.name });
  expect(getContactMock).toHaveBeenCalledTimes(1);
  expect(getContactMock).toHaveBeenCalledWith(
    { contactId },
    {
      baseUrl: 'http://localhost:4101/crm-api',
      correlationId: expect.any(String),
      locale: 'en',
    },
  );
  expect(runEffectRequestMock).toHaveBeenCalledTimes(1);
});

test('suppresses all Contact fields when the decoded Contact belongs to another Customer', async () => {
  getContactMock.mockReturnValue(Effect.succeed({ ...activeContact, customerId: otherCustomerId }));
  render(<ContactDetailPage routeParams={{ contactId, id: customerId }} />);

  expect(
    await screen.findByText('This Contact could not be found for the selected Customer.'),
  ).toBeTruthy();
  expect(screen.queryByText(activeContact.name)).toBeNull();
  expect(screen.queryByText(activeContact.email)).toBeNull();
  expect(screen.queryByText(activeContact.phone)).toBeNull();
  expect(getContactMock).toHaveBeenCalledTimes(1);
});

test('renders the parent link, heading, semantic overview, communication links, lifecycle, and times', async () => {
  render(<ContactDetailPage routeParams={{ contactId, id: customerId }} />);

  const heading = await screen.findByRole('heading', { name: activeContact.name });
  expect(heading.className).toContain('crm:break-words');
  expect(screen.getByRole('link', { name: 'Back to Customer' }).getAttribute('href')).toBe(
    `/en/crm/customers/${customerId}`,
  );
  const list = document.querySelector('dl');
  expect(list).not.toBeNull();
  expect(within(list as HTMLElement).getByText('Contact ID')).toBeTruthy();
  expect(list?.textContent).toContain(contactId);
  expect(list?.textContent).toContain(customerId);
  expect(
    screen.getByRole('link', { name: 'Send email to this Contact' }).getAttribute('href'),
  ).toBe(`mailto:${activeContact.email}`);
  expect(screen.getByRole('link', { name: 'Call this Contact' }).getAttribute('href')).toBe(
    `tel:${activeContact.phone}`,
  );
  expect(within(list as HTMLElement).getByText('Active')).toBeTruthy();
  const times = list?.querySelectorAll('time');
  expect(times).toHaveLength(2);
  expect(times?.[0]?.getAttribute('datetime')).toBe(activeContact.createdAt);
  expect(times?.[1]?.getAttribute('datetime')).toBe(activeContact.updatedAt);
  expect(document.querySelector('[role="tablist"]')).toBeNull();
  expect(document.querySelector('table')).toBeNull();
});

test('keeps empty persisted communication values labeled without inventing links or copy', async () => {
  getContactMock.mockReturnValue(Effect.succeed({ ...activeContact, email: '', phone: '' }));
  render(<ContactDetailPage routeParams={{ contactId, id: customerId }} />);

  await screen.findByRole('heading', { name: activeContact.name });
  expect(screen.queryByRole('link', { name: 'Send email to this Contact' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Call this Contact' })).toBeNull();
  expect(screen.getByText('Email').nextElementSibling?.textContent).toBe('');
  expect(screen.getByText('Phone').nextElementSibling?.textContent).toBe('');
});

test('keeps a semantic busy announcement and stable seven-row skeleton while loading', () => {
  getContactMock.mockReturnValue(Effect.never);
  render(<ContactDetailPage routeParams={{ contactId, id: customerId }} />);

  expect(screen.getByRole('status').textContent).toBe('Loading Contact details…');
  expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(document.querySelectorAll('dt')).toHaveLength(7);
  expect(screen.getByTestId('contact-detail-results').getAttribute('aria-live')).toBe('polite');
});

test('renders Czech archived data and preserves the locale and Customer ID in the parent link', async () => {
  localeState.current = 'cs';
  getContactMock.mockReturnValue(Effect.succeed(archivedContact));
  render(<ContactDetailPage routeParams={{ contactId, id: customerId }} />);

  expect(await screen.findByRole('heading', { name: archivedContact.name })).toBeTruthy();
  expect(screen.getByText('Archivovaný')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Zpět na zákazníka' }).getAttribute('href')).toBe(
    `/cs/crm/customers/${customerId}`,
  );
});

test.each([
  [
    'ContactDetailNotFoundProblem',
    'This Contact could not be found for the selected Customer.',
    false,
  ],
  ['ContactDetailForbiddenProblem', 'You do not have permission to view this Contact.', false],
  [
    'ContactDetailAuthenticationProblem',
    'Your session has expired. Try again after signing in.',
    true,
  ],
  ['ContactDetailUnavailableProblem', 'The Contact is temporarily unavailable. Try again.', true],
] as const)('maps %s to its explicit presentation state', async (tag, message, retryable) => {
  getContactMock.mockReturnValue(Effect.fail({ _tag: tag } as never));
  render(<ContactDetailPage routeParams={{ contactId, id: customerId }} />);

  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe(message);
  expect(screen.queryByRole('button', { name: 'Try again' }) !== null).toBe(retryable);
});

test('retries an unavailable request from the keyboard and restores focus after completion', async () => {
  getContactMock
    .mockReturnValueOnce(Effect.fail({ _tag: 'ContactDetailUnavailableProblem' } as never))
    .mockReturnValueOnce(Effect.succeed(activeContact));
  const user = userEvent.setup();
  render(<ContactDetailPage routeParams={{ contactId, id: customerId }} />);

  const retry = await screen.findByRole('button', { name: 'Try again' });
  retry.focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('heading', { name: activeContact.name })).toBeTruthy();
  expect(getContactMock).toHaveBeenCalledTimes(2);
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByTestId('contact-detail-results')),
  );
});

test('maps the complete remaining client failure families without exposing raw errors', () => {
  expect(classifyContactDetailError({ _tag: 'ContactDetailInvalidProblem' } as never)).toEqual({
    state: 'not_found',
  });
  expect(classifyContactDetailError({ _tag: 'GatewayForbiddenProblem' } as never)).toEqual({
    state: 'forbidden',
  });
  expect(
    classifyContactDetailError({ _tag: 'GatewayAuthenticationRequiredProblem' } as never),
  ).toEqual({ state: 'authentication_expired' });
  expect(classifyContactDetailError({ _tag: 'SchemaError' } as never)).toEqual({
    reason: 'decode',
    state: 'unavailable',
  });
  expect(
    classifyContactDetailError({
      _tag: 'HttpClientError',
      reason: { _tag: 'TransportError' },
    } as never),
  ).toEqual({ reason: 'transport', state: 'unavailable' });
  for (const tag of [
    'ContactDetailUnavailableProblem',
    'GatewayRateLimitedProblem',
    'GatewayUnavailableProblem',
  ] as const) {
    expect(classifyContactDetailError({ _tag: tag } as never)).toEqual({
      reason: 'backend',
      state: 'unavailable',
    });
  }
  for (const tag of [
    'ContactDetailInternalProblem',
    'GatewayAudienceInvalidProblem',
    'GatewayInternalProblem',
  ] as const) {
    expect(classifyContactDetailError({ _tag: tag } as never)).toEqual({
      reason: 'internal',
      state: 'unavailable',
    });
  }
});

test('builds only matching-parent ready models and linkifies only decoded usable values', () => {
  expect(toContactDetailReadyModel(activeContact, otherCustomerId, 'en')).toBeUndefined();
  expect(toContactDetailReadyModel(activeContact, customerId, 'en')).toMatchObject({
    emailHref: `mailto:${activeContact.email}`,
    lifecycle: 'active',
    phoneHref: `tel:${activeContact.phone}`,
  });
  expect(
    toContactDetailReadyModel({ ...activeContact, email: '', phone: '' }, customerId, 'en'),
  ).not.toHaveProperty('emailHref');
});

test('keeps locale parity, long-value wrapping, and the generated frontend seam', () => {
  expect(flattenKeys(csCatalog.crm.pages.contactDetail)).toEqual(
    flattenKeys(enCatalog.crm.pages.contactDetail),
  );
  const source = readFileSync(
    new URL(
      '../../src/routes/[lang]/crm/customers/[id]/contacts/[contactId]/page.tsx',
      import.meta.url,
    ),
    'utf-8',
  );
  expect(source).toContain("from '../../../../../../../api/crm-client.ts'");
  expect(source).toContain('crm:break-words');
  expect(source).toContain('crm:break-all');
  expect(source).toContain('crm:block');
  expect(source).not.toMatch(/\bfetch\s*\(/u);
  expect(source).not.toMatch(/contact-detail-read-server|src\/db|CustomerContactPersistence/u);
  expect(source).not.toContain('HttpApiEndpoint');
});
