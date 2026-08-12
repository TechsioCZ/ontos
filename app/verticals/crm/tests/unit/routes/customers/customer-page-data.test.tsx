import { expect, rstest, test } from '@rstest/core';
import { Effect } from 'effect';
import type { CustomerView } from '../../../../shared/apis/customer-directory.ts';
import {
  loadCustomerPageModel,
  parseCustomerRouteState,
} from '../../../../src/routes/[lang]/customers/page.data.ts';
import type { CustomerPageClients } from '../../../../src/routes/[lang]/customers/page.data.ts';
import {
  customerFormToWritableFields,
  emptyCustomerFormValues,
  validateCustomerForm,
} from '../../../../src/customers/customer-view-model.ts';

const customerId = '10000000-0000-4000-8000-000000000001';
const otherCustomerId = '20000000-0000-4000-8000-000000000002';
const cursor = `YWNtZQ.${customerId}`;

const customer = (overrides: Partial<CustomerView> = {}): CustomerView => ({
  address: {
    addressLine1: 'A very long address line that remains available to presentation',
    addressLine2: null,
    city: 'Prague',
    countryCode: 'CZ',
    postalCode: '11000',
    region: null,
  },
  companyRegistrationNumber: '12345678',
  createdAt: '2026-08-10T12:00:00.000Z',
  customerId,
  email: 'hello@example.test',
  name: 'A company name that remains complete even when it is very long',
  phone: '+420 123 456 789',
  taxIdentificationNumber: 'CZ12345678',
  updatedAt: '2026-08-10T12:00:00.000Z',
  version: 3,
  website: 'https://example.test/',
  ...overrides,
});

test('parses bounded shareable cursor, page, and selected customer state', () => {
  expect(
    parseCustomerRouteState(
      new URL(
        `https://crm.example.test/en/customers?page=2&cursor=${cursor}&customer=${customerId}`,
      ),
    ),
  ).toEqual({
    state: 'valid',
    value: { cursor, page: 2, selectedCustomerId: customerId },
  });
  expect(parseCustomerRouteState(new URL('https://crm.example.test/en/customers?page=0'))).toEqual({
    reason: 'invalid_page',
    state: 'invalid',
  });
  expect(parseCustomerRouteState(new URL('https://crm.example.test/en/customers?page=2'))).toEqual({
    reason: 'invalid_cursor',
    state: 'invalid',
  });
  expect(
    parseCustomerRouteState(
      new URL('https://crm.example.test/en/customers?customer=not-a-customer-id'),
    ),
  ).toEqual({ reason: 'invalid_selection', state: 'invalid' });
});

test('maps list and direct detail reads through the generated directory client', async () => {
  const directory = rstest.fn<CustomerPageClients['directory']>((payload) =>
    payload.operation === 'list'
      ? Effect.succeed({
          items: [customer()],
          nextCursor: cursor,
          operation: 'list' as const,
        })
      : Effect.succeed({ customer: customer(), operation: 'detail' as const }),
  );
  const model = await loadCustomerPageModel(
    { url: `https://crm.example.test/en/customers?customer=${customerId}` },
    { directory },
  );

  expect(model).toMatchObject({
    detail: { customerId, name: customer().name, version: 3 },
    pagination: { page: 1 },
    rows: [{ customerId, selected: true }],
    state: 'resolved',
  });
  expect(model.state === 'resolved' ? model.pagination.nextHref : undefined).toBe(
    `/en/customers?page=2&cursor=${encodeURIComponent(cursor)}&customer=${customerId}`,
  );
  expect(directory).toHaveBeenCalledTimes(2);
  expect(directory.mock.calls[0]?.[0]).toEqual({ limit: 20, operation: 'list' });
  expect(directory.mock.calls[1]?.[0]).toEqual({ customerId, operation: 'detail' });
});

test('does not add a CRM search request or behavior when unrelated URL parameters exist', async () => {
  const directory = rstest.fn<CustomerPageClients['directory']>(() =>
    Effect.succeed({ items: [], nextCursor: null, operation: 'list' as const }),
  );
  const model = await loadCustomerPageModel(
    { url: 'https://crm.example.test/en/customers?unrelated=ignored' },
    { directory },
  );
  expect(model).toEqual({ pagination: { page: 1 }, state: 'empty' });
  expect(directory.mock.calls[0]?.[0]).toEqual({ limit: 20, operation: 'list' });
});

test.each([
  ['CustomerDirectoryForbiddenProblem', 'forbidden'],
  ['CustomerDirectoryNotFoundProblem', 'not_found'],
  ['CustomerDirectoryUnavailableProblem', 'unavailable'],
  ['HttpClientError', 'unavailable'],
] as const)('maps %s to the explicit %s route state', async (tag, expectedState) => {
  const directory = (() => Effect.fail({ _tag: tag })) as CustomerPageClients['directory'];
  await expect(
    loadCustomerPageModel({ url: 'https://crm.example.test/en/customers' }, { directory }),
  ).resolves.toMatchObject({ state: expectedState });
});

test.each([
  [401, 'forbidden'],
  [403, 'forbidden'],
  [404, 'not_found'],
  [503, 'unavailable'],
] as const)(
  'maps transport status %s to the explicit %s route state',
  async (status, expectedState) => {
    const directory = (() => Effect.fail({ status })) as CustomerPageClients['directory'];
    await expect(
      loadCustomerPageModel({ url: 'https://crm.example.test/en/customers' }, { directory }),
    ).resolves.toMatchObject({ state: expectedState });
  },
);

test('validates every client-side field without erasing partially supplied address values', () => {
  expect(
    validateCustomerForm({
      ...emptyCustomerFormValues,
      addressLine1: 'Main 1',
      countryCode: 'CZE',
      email: 'invalid',
      name: ' ',
      website: 'ftp://example.test',
    }),
  ).toEqual([
    { code: 'required', field: 'name' },
    { code: 'too_long', field: 'countryCode' },
    { code: 'invalid_email', field: 'email' },
    { code: 'invalid_website', field: 'website' },
    { code: 'invalid_country_code', field: 'countryCode' },
  ]);
  expect(
    customerFormToWritableFields({
      ...emptyCustomerFormValues,
      addressLine1: ' Main 1 ',
      countryCode: 'cz',
      name: ' Acme ',
    }),
  ).toEqual({
    address: { addressLine1: 'Main 1', countryCode: 'CZ' },
    name: 'Acme',
  });
  expect(
    validateCustomerForm({
      ...emptyCustomerFormValues,
      addressLine1: 'Main 1',
      name: 'Acme',
    }),
  ).toEqual([{ code: 'required', field: 'countryCode' }]);
});

test('does not emit a page beyond the bounded maximum even when the server returns a cursor', async () => {
  const directory = (() =>
    Effect.succeed({
      items: [customer()],
      nextCursor: cursor,
      operation: 'list' as const,
    })) as CustomerPageClients['directory'];
  const model = await loadCustomerPageModel(
    { url: `https://crm.example.test/en/customers?page=100&cursor=${cursor}` },
    { directory },
  );
  expect(model.state).toBe('resolved');
  expect(model.state === 'resolved' ? model.pagination.nextHref : undefined).toBeUndefined();
});

test('reports a direct-detail not-found after the list succeeds', async () => {
  const directory = ((payload: { readonly operation: 'detail' | 'list' }) =>
    payload.operation === 'list'
      ? Effect.succeed({
          items: [customer({ customerId: otherCustomerId })],
          nextCursor: null,
          operation: 'list' as const,
        })
      : Effect.fail({
          _tag: 'CustomerDirectoryNotFoundProblem',
        })) as CustomerPageClients['directory'];
  await expect(
    loadCustomerPageModel(
      { url: `https://crm.example.test/en/customers?customer=${customerId}` },
      { directory },
    ),
  ).resolves.toEqual({ state: 'not_found' });
});
