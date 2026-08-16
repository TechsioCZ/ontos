// @effect-diagnostics asyncFunction:off anyUnknownInErrorContext:off nodeBuiltinImport:off
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, rstest, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect } from 'effect';
import type { ReactNode } from 'react';
import csCatalog from '../../locales/cs/crm.json';
import enCatalog from '../../locales/en/crm.json';
import {
  CustomerEditFeature,
  classifyCustomerDetailError,
  classifyEditCustomerError,
  customerDetailQueryKey,
  decodeCustomerEditId,
} from '../../src/routes/[lang]/crm/customers/[id]/edit/page.tsx';

Object.assign(globalThis, {
  ULTRAMODERN_CRM_API_BASE_URL: 'http://localhost:4101/crm-api',
});

const { editCustomerMock, getCustomerDetailMock, localeState, navigateMock, runEffectRequestMock } =
  rstest.hoisted(() => ({
    editCustomerMock: rstest.fn(),
    getCustomerDetailMock: rstest.fn(),
    localeState: { current: 'en' as 'cs' | 'en' },
    navigateMock: rstest.fn(() => Promise.resolve()),
    runEffectRequestMock: rstest.fn(),
  }));

const catalogs = { cs: csCatalog, en: enCatalog } as const;
const translate = (language: 'cs' | 'en', key: string): string => {
  let current: unknown = catalogs[language];
  for (const segment of key.split('.')) {
    current =
      typeof current === 'object' && current !== null
        ? (current as Record<string, unknown>)[segment]
        : undefined;
  }
  return typeof current === 'string' ? current : key;
};

const flattenKeys = (value: object, prefix = ''): string[] =>
  Object.entries(value)
    .flatMap(([key, child]) => {
      const path = prefix.length === 0 ? key : `${prefix}.${key}`;
      return typeof child === 'object' && child !== null ? flattenKeys(child, path) : [path];
    })
    .sort();

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    language: localeState.current,
    t: (key: string) => translate(localeState.current, key),
  }),
}));

rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a {...props} href={to}>
      {children}
    </a>
  ),
  useNavigate: () => navigateMock,
}));

rstest.mock('../../src/api/crm-client.ts', () => ({
  editCustomer: editCustomerMock,
  getCustomerDetail: getCustomerDetailMock,
  runEffectRequest: runEffectRequestMock,
}));

rstest.mock('../../src/routes/ultramodern-route-head.tsx', () => ({
  UltramodernRouteHead: () => null,
}));

const customerId = '11111111-1111-4111-8111-111111111111';
const customer = {
  archivedAt: null,
  createdAt: '2026-08-13T08:15:00.000Z',
  customerId,
  name: 'Acme Property Group',
  updatedAt: '2026-08-14T09:30:00.000Z',
} as const;
const updatedCustomer = {
  ...customer,
  name: 'Updated Customer',
  updatedAt: '2026-08-15T09:30:00.000Z',
} as const;

const renderFeature = ({
  id = customerId,
  writable = true,
}: { readonly id?: string; readonly writable?: boolean } = {}) => {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CustomerEditFeature routeParams={{ id }} target={{ writable }} />
    </QueryClientProvider>,
  );
  return queryClient;
};

beforeEach(() => {
  localeState.current = 'en';
  navigateMock.mockResolvedValue();
  getCustomerDetailMock.mockReturnValue(Effect.succeed(customer));
  editCustomerMock.mockReturnValue(Effect.succeed(updatedCustomer));
  runEffectRequestMock.mockImplementation((effect: Effect.Effect<unknown, unknown>) =>
    Effect.runPromise(effect),
  );
});

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

test('loads the exact route Customer through the typed client and prefills the form', async () => {
  renderFeature();

  const name = await screen.findByRole('textbox', { name: /^Customer name/u });
  expect(name.getAttribute('value')).toBe('Acme Property Group');
  expect(getCustomerDetailMock).toHaveBeenCalledTimes(1);
  expect(getCustomerDetailMock).toHaveBeenCalledWith(
    { customerId },
    {
      baseUrl: 'http://localhost:4101/crm-api',
      correlationId: expect.any(String),
      locale: 'en',
    },
  );
  expect(runEffectRequestMock).toHaveBeenCalledTimes(1);
});

test('renders loading and rejects missing or malformed IDs without a BFF call', () => {
  getCustomerDetailMock.mockReturnValue(Effect.never);
  renderFeature();
  expect(screen.getByRole('status').textContent).toBe('Loading Customer…');

  cleanup();
  rstest.clearAllMocks();
  renderFeature({ id: 'not-a-customer-id' });
  expect(screen.getByRole('status').textContent).toBe(
    'This Customer was not found or is not available to you.',
  );
  expect(getCustomerDetailMock).not.toHaveBeenCalled();
  expect(decodeCustomerEditId({})).toBeUndefined();
});

test.each([
  [
    'CustomerDetailNotFoundProblem',
    'This Customer was not found or is not available to you.',
    false,
  ],
  ['CustomerDetailForbiddenProblem', 'You do not have permission to view this Customer.', false],
  ['CustomerDetailAuthenticationProblem', 'Your session has expired. Sign in and try again.', true],
] as const)('renders the explicit %s detail state', async (tag, message, retryable) => {
  getCustomerDetailMock.mockReturnValue(Effect.fail({ _tag: tag } as never));
  renderFeature();

  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Try again' }) !== null).toBe(retryable);
});

test('bounds automatic temporary retries and exposes a semantic retry action', async () => {
  getCustomerDetailMock.mockReturnValue(
    Effect.fail({ _tag: 'CustomerDetailUnavailableProblem' } as never),
  );
  renderFeature();

  expect(
    await screen.findByText('The Customer service is temporarily unavailable. Try again.'),
  ).toBeTruthy();
  expect(getCustomerDetailMock).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
});

test('maps transport, decode, backend, and unexpected detail failures without retrying denials', () => {
  expect(
    classifyCustomerDetailError({
      _tag: 'HttpClientError',
      reason: { _tag: 'TransportError' },
    } as never),
  ).toEqual({ reason: 'transport', state: 'unavailable' });
  expect(classifyCustomerDetailError({ _tag: 'SchemaError' } as never)).toEqual({
    reason: 'decode',
    state: 'unavailable',
  });
  expect(classifyCustomerDetailError({ _tag: 'GatewayUnavailableProblem' } as never)).toEqual({
    reason: 'backend',
    state: 'unavailable',
  });
  expect(classifyCustomerDetailError({ _tag: 'GatewayInternalProblem' } as never)).toEqual({
    reason: 'unexpected',
    state: 'unavailable',
  });
  expect(classifyCustomerDetailError({ _tag: 'GatewayForbiddenProblem' } as never)).toEqual({
    state: 'forbidden',
  });
});

test('keeps a read-only Customer readable without an enabled mutation path', async () => {
  renderFeature({ writable: false });

  expect(
    await screen.findByText(
      'CRM is currently read-only. You can review this Customer, but cannot save changes.',
    ),
  ).toBeTruthy();
  expect(screen.getByRole('textbox', { name: /^Customer name/u }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(true);
  expect(editCustomerMock).not.toHaveBeenCalled();
});

test('submits the normalized payload, updates the detail cache, and navigates locally', async () => {
  const queryClient = renderFeature();
  const user = userEvent.setup();
  const name = await screen.findByRole('textbox', { name: /^Customer name/u });
  await user.clear(name);
  await user.type(name, '  Updated Customer  ');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/en/crm/customers' }));
  expect(editCustomerMock).toHaveBeenCalledWith(
    { customerId, name: 'Updated Customer' },
    {
      baseUrl: 'http://localhost:4101/crm-api',
      correlationId: expect.any(String),
      idempotencyKey: expect.any(String),
      locale: 'en',
    },
  );
  expect(queryClient.getQueryData(customerDetailQueryKey(customerId))).toEqual(updatedCustomer);
  expect(screen.getByRole('status').textContent).toBe('Customer changes saved.');
});

test('reuses an idempotency key only for an uncertain retry of the same intent', async () => {
  editCustomerMock
    .mockReturnValueOnce(
      Effect.fail({ _tag: 'HttpClientError', reason: { _tag: 'TransportError' } } as never),
    )
    .mockReturnValueOnce(Effect.succeed(updatedCustomer));
  const user = userEvent.setup();
  renderFeature();
  await screen.findByRole('textbox', { name: /^Customer name/u });

  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(
    await screen.findByText(
      'The Customer service could not be reached. Check your connection and try again.',
    ),
  ).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(editCustomerMock).toHaveBeenCalledTimes(2));

  const firstOptions = editCustomerMock.mock.calls[0]?.[1];
  const secondOptions = editCustomerMock.mock.calls[1]?.[1];
  expect(secondOptions.idempotencyKey).toBe(firstOptions.idempotencyKey);
  expect(secondOptions.correlationId).not.toBe(firstOptions.correlationId);
});

test('creates a new idempotency key after the user changes the failed intent', async () => {
  editCustomerMock.mockReturnValue(Effect.fail({ _tag: 'CrmUnavailableProblem' } as never));
  const user = userEvent.setup();
  renderFeature();
  const name = await screen.findByRole('textbox', { name: /^Customer name/u });

  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await screen.findByText('The Customer service is temporarily unavailable. Try again.');
  await user.type(name, ' changed');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(editCustomerMock).toHaveBeenCalledTimes(2));

  expect(editCustomerMock.mock.calls[1]?.[1].idempotencyKey).not.toBe(
    editCustomerMock.mock.calls[0]?.[1].idempotencyKey,
  );
});

test.each([
  ['CrmInvalidRequestProblem', 'Enter a valid Customer name.'],
  ['CrmAuthenticationProblem', 'Your session expired before the Customer could be saved.'],
  ['CrmForbiddenProblem', 'You do not have permission to edit this Customer.'],
  ['CrmNotFoundProblem', 'This Customer no longer exists or is not available to you.'],
  [
    'CrmConflictProblem',
    'The Customer changed while you were editing it. Review the current value and try again.',
  ],
  ['CrmInternalProblem', 'The Customer could not be saved safely. Try again.'],
] as const)('maps the %s mutation failure into the form', async (tag, message) => {
  editCustomerMock.mockReturnValue(Effect.fail({ _tag: tag } as never));
  const user = userEvent.setup();
  renderFeature();
  await screen.findByRole('textbox', { name: /^Customer name/u });

  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(await screen.findByText(message)).toBeTruthy();
  expect(navigateMock).not.toHaveBeenCalled();
});

test('maps all mutation failure families to a closed presentation vocabulary', () => {
  expect(classifyEditCustomerError({ _tag: 'CrmInvalidRequestProblem' } as never)).toEqual({
    state: 'name_invalid',
  });
  expect(classifyEditCustomerError({ _tag: 'GatewayForbiddenProblem' } as never)).toEqual({
    state: 'forbidden',
  });
  expect(classifyEditCustomerError({ _tag: 'CrmConflictProblem' } as never)).toEqual({
    state: 'conflict',
  });
  expect(classifyEditCustomerError({ _tag: 'SchemaError' } as never)).toEqual({
    reason: 'decode',
    state: 'unavailable',
    uncertain: true,
  });
  expect(classifyEditCustomerError({ _tag: 'GatewayUnavailableProblem' } as never)).toEqual({
    reason: 'backend',
    state: 'unavailable',
    uncertain: true,
  });
  expect(classifyEditCustomerError({ _tag: 'GatewayAudienceInvalidProblem' } as never)).toEqual({
    state: 'unexpected',
  });
});

test('Back and Cancel use the localized Customers route without invoking a mutation', async () => {
  localeState.current = 'cs';
  const user = userEvent.setup();
  renderFeature();

  const back = await screen.findByRole('link', { name: 'Zpět na zákazníky' });
  expect(back.getAttribute('href')).toBe('/cs/crm/customers');
  expect(screen.getByRole('heading', { name: 'Upravit zákazníka' })).toBeTruthy();
  await user.click(await screen.findByRole('button', { name: 'Zrušit' }));
  expect(navigateMock).toHaveBeenCalledWith({ to: '/cs/crm/customers' });
  expect(editCustomerMock).not.toHaveBeenCalled();
});

describe('generated boundaries and localization', () => {
  test('keeps the form private and the page behind generated owner/Shell wiring', () => {
    const pageSource = readFileSync(
      new URL('../../src/routes/[lang]/crm/customers/[id]/edit/page.tsx', import.meta.url),
      'utf-8',
    );
    const manifest = readFileSync(new URL('../../vertical.manifest.ts', import.meta.url), 'utf-8');
    const registration = readFileSync(
      new URL('../../vertical.registration.ts', import.meta.url),
      'utf-8',
    );
    const federation = readFileSync(
      new URL('../../module-federation.config.ts', import.meta.url),
      'utf-8',
    );
    expect(pageSource).toContain('getCustomerDetail(');
    expect(pageSource).toContain('editCustomer(');
    expect(pageSource).toContain('target={{ writable: false }}');
    expect(pageSource).not.toMatch(/\bfetch\s*\(|api\/customer-detail-read-server|src\/db/u);
    expect(manifest).toContain("contributionKey: 'crm.core.page.customer-edit'");
    expect(manifest).toContain("routePath: '/crm/customers/:id/edit'");
    expect(manifest).not.toContain('crm.core.navigation.customer-edit');
    expect(registration).toContain("'page-customer-edit': () => import(");
    expect(federation).toContain("'./PageCustomerEdit'");
    expect(manifest).not.toContain('customer-form');
    expect(registration).not.toContain('customer-form');
  });

  test('keeps English and Czech CustomerEdit locale structures in parity', () => {
    expect(flattenKeys(csCatalog.crm.pages.customerEdit)).toEqual(
      flattenKeys(enCatalog.crm.pages.customerEdit),
    );
  });
});
