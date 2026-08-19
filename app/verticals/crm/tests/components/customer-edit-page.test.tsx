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

const {
  editCustomerMock,
  getCustomerDetailMock,
  historyBackMock,
  historyCanGoBack,
  localeState,
  navigateMock,
  runEffectRequestMock,
} = rstest.hoisted(() => ({
  editCustomerMock: rstest.fn(),
  getCustomerDetailMock: rstest.fn(),
  historyBackMock: rstest.fn(),
  historyCanGoBack: { current: false },
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
    .toSorted();

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
  useRouter: () => ({
    history: {
      back: historyBackMock,
      canGoBack: () => historyCanGoBack.current,
    },
  }),
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
  dic: 'CZ00123456',
  dissolvedOn: '2026-08-17',
  establishedOn: '2020-01-02',
  ico: '00123456',
  legalFormCode: '112',
  name: 'Acme Property Group',
  updatedAt: '2026-08-14T09:30:00.000Z',
} as const;
const updatedCustomer = {
  ...customer,
  name: 'Updated Customer',
  updatedAt: '2026-08-15T09:30:00.000Z',
} as const;
const nullableArchivedCustomer = {
  ...customer,
  archivedAt: '2026-08-16T10:00:00.000Z',
  dic: null,
  dissolvedOn: null,
  establishedOn: null,
  ico: null,
  legalFormCode: null,
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
  historyCanGoBack.current = false;
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
  expect(document.querySelector<HTMLInputElement>('#customer-ico')?.value).toBe('00123456');
  expect(document.querySelector<HTMLInputElement>('#customer-dic')?.value).toBe('CZ00123456');
  expect(document.querySelector<HTMLInputElement>('#customer-legal-form-code')?.value).toBe('112');
  expect(document.querySelector<HTMLInputElement>('#customer-established-on')?.value).toBe(
    '2020-01-02',
  );
  expect(document.querySelector<HTMLInputElement>('#customer-dissolved-on')?.value).toBe(
    '2026-08-17',
  );
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
  expect(screen.queryByText(/ARES/u)).toBeNull();
});

test('prefills every nullable field as an empty controlled value for an archived Customer', async () => {
  getCustomerDetailMock.mockReturnValue(Effect.succeed(nullableArchivedCustomer));
  renderFeature();

  const name = await screen.findByLabelText(/^Customer name/u);
  expect(name.getAttribute('value')).toBe(nullableArchivedCustomer.name);
  for (const selector of [
    '#customer-ico',
    '#customer-dic',
    '#customer-legal-form-code',
    '#customer-established-on',
    '#customer-dissolved-on',
  ]) {
    expect(document.querySelector<HTMLInputElement>(selector)?.value).toBe('');
  }
  expect(screen.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(false);
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

test.each([
  ['customer-name', ' ', 'Enter a Customer name.'],
  ['customer-ico', '1234567', 'Enter an IČO containing exactly eight digits.'],
  ['customer-dic', 'X'.repeat(21), 'Enter a DIČ with at most 20 characters.'],
  ['customer-legal-form-code', '12A', 'Enter a legal-form code containing exactly three digits.'],
  [
    'customer-dissolved-on',
    '2019-12-31',
    'The dissolution date cannot be before the establishment date.',
  ],
] as const)(
  'maps invalid %s input to its field without calling the BFF',
  async (id, value, message) => {
    const user = userEvent.setup();
    renderFeature();
    await screen.findByRole('textbox', { name: /^Customer name/u });
    const input = document.querySelector<HTMLInputElement>(`#${id}`);
    expect(input).not.toBeNull();
    await user.clear(input as HTMLInputElement);
    await user.type(input as HTMLInputElement, value);

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(message)).toBeTruthy();
    expect((input as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
    expect(editCustomerMock).not.toHaveBeenCalled();
  },
);

test('submits the normalized payload, updates the detail cache, and navigates locally', async () => {
  const queryClient = renderFeature();
  const user = userEvent.setup();
  const name = await screen.findByRole('textbox', { name: /^Customer name/u });
  await user.clear(name);
  await user.type(name, '  Updated Customer  ');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/en/crm/customers' }));
  expect(editCustomerMock).toHaveBeenCalledWith(
    {
      customerId,
      dic: 'CZ00123456',
      dissolvedOn: '2026-08-17',
      establishedOn: '2020-01-02',
      ico: '00123456',
      legalFormCode: '112',
      name: 'Updated Customer',
    },
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

test('normalizes explicitly cleared optional fields to null in the exact edit payload', async () => {
  const user = userEvent.setup();
  renderFeature();
  const name = await screen.findByRole('textbox', { name: /^Customer name/u });
  await user.clear(name);
  await user.type(name, 'Cleared Customer');
  const ico = document.querySelector<HTMLInputElement>('#customer-ico');
  const dic = document.querySelector<HTMLInputElement>('#customer-dic');
  const legalFormCode = document.querySelector<HTMLInputElement>('#customer-legal-form-code');
  const establishedOn = document.querySelector<HTMLInputElement>('#customer-established-on');
  const dissolvedOn = document.querySelector<HTMLInputElement>('#customer-dissolved-on');
  expect(ico).not.toBeNull();
  expect(dic).not.toBeNull();
  expect(legalFormCode).not.toBeNull();
  expect(establishedOn).not.toBeNull();
  expect(dissolvedOn).not.toBeNull();
  await user.clear(ico as HTMLInputElement);
  await user.clear(dic as HTMLInputElement);
  await user.clear(legalFormCode as HTMLInputElement);
  await user.clear(establishedOn as HTMLInputElement);
  await user.clear(dissolvedOn as HTMLInputElement);

  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(editCustomerMock).toHaveBeenCalledTimes(1));

  expect(editCustomerMock.mock.calls[0]?.[0]).toEqual({
    customerId,
    dic: null,
    dissolvedOn: null,
    establishedOn: null,
    ico: null,
    legalFormCode: null,
    name: 'Cleared Customer',
  });
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

test('creates a new idempotency key when an optional field is cleared after an uncertain failure', async () => {
  editCustomerMock.mockReturnValue(Effect.fail({ _tag: 'CrmUnavailableProblem' } as never));
  const user = userEvent.setup();
  renderFeature();
  await screen.findByRole('textbox', { name: /^Customer name/u });

  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await screen.findByText('The Customer service is temporarily unavailable. Try again.');
  const ico = document.querySelector<HTMLInputElement>('#customer-ico');
  expect(ico).not.toBeNull();
  await user.clear(ico as HTMLInputElement);
  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(editCustomerMock).toHaveBeenCalledTimes(2));

  expect(editCustomerMock.mock.calls[1]?.[0].ico).toBeNull();
  expect(editCustomerMock.mock.calls[1]?.[1].idempotencyKey).not.toBe(
    editCustomerMock.mock.calls[0]?.[1].idempotencyKey,
  );
});

test('preserves the complete unsaved draft after a retryable mutation failure', async () => {
  editCustomerMock.mockReturnValue(Effect.fail({ _tag: 'CrmUnavailableProblem' } as never));
  const user = userEvent.setup();
  renderFeature();
  const name = await screen.findByRole('textbox', { name: /^Customer name/u });
  const ico = document.querySelector<HTMLInputElement>('#customer-ico');
  expect(ico).not.toBeNull();
  await user.clear(name);
  await user.type(name, 'Unsaved draft');
  await user.clear(ico as HTMLInputElement);
  await user.type(ico as HTMLInputElement, '87654321');

  await user.click(screen.getByRole('button', { name: 'Save changes' }));
  await screen.findByText('The Customer service is temporarily unavailable. Try again.');

  expect(name.getAttribute('value')).toBe('Unsaved draft');
  expect((ico as HTMLInputElement).value).toBe('87654321');
  expect(navigateMock).not.toHaveBeenCalled();
});

test('guards every edit control while the mutation is pending and suppresses duplicate submits', async () => {
  let settle!: () => void;
  editCustomerMock.mockReturnValue(
    Effect.callback<typeof updatedCustomer>((resume) => {
      settle = () => resume(Effect.succeed(updatedCustomer));
    }),
  );
  const user = userEvent.setup();
  renderFeature();
  await screen.findByRole('textbox', { name: /^Customer name/u });

  await user.dblClick(screen.getByRole('button', { name: 'Save changes' }));
  const saving = await screen.findByRole('button', { name: 'Saving changes…' });
  expect(saving.hasAttribute('disabled')).toBe(true);
  for (const selector of [
    '#customer-name',
    '#customer-ico',
    '#customer-dic',
    '#customer-legal-form-code',
    '#customer-established-on',
    '#customer-dissolved-on',
  ]) {
    expect(document.querySelector<HTMLInputElement>(selector)?.hasAttribute('disabled')).toBe(true);
  }
  expect(editCustomerMock).toHaveBeenCalledTimes(1);

  settle();
  await waitFor(() => expect(navigateMock).toHaveBeenCalledTimes(1));
});

test.each([
  [
    'CrmInvalidRequestProblem',
    'Review the Customer business fields and correct the invalid values.',
  ],
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

test('maps duplicate IČO to a distinct safe and actionable warning', async () => {
  editCustomerMock.mockReturnValue(
    Effect.fail({ _tag: 'CrmConflictProblem', code: 'crm_customer_ico_conflict' } as never),
  );
  const user = userEvent.setup();
  renderFeature();
  await screen.findByRole('textbox', { name: /^Customer name/u });

  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  expect(
    await screen.findByText(
      'A Customer with this IČO already exists. Enter a different IČO and try again.',
    ),
  ).toBeTruthy();
  expect(navigateMock).not.toHaveBeenCalled();
});

test('maps all mutation failure families to a closed presentation vocabulary', () => {
  expect(classifyEditCustomerError({ _tag: 'CrmInvalidRequestProblem' } as never)).toEqual({
    state: 'invalid',
  });
  expect(classifyEditCustomerError({ _tag: 'GatewayForbiddenProblem' } as never)).toEqual({
    state: 'forbidden',
  });
  expect(
    classifyEditCustomerError({ _tag: 'CrmConflictProblem', code: 'crm_conflict' } as never),
  ).toEqual({ state: 'conflict' });
  expect(
    classifyEditCustomerError({
      _tag: 'CrmConflictProblem',
      code: 'crm_customer_ico_conflict',
    } as never),
  ).toEqual({ state: 'ico_conflict' });
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

  const back = await screen.findByRole('link', { name: 'Zpět' });
  expect(back.getAttribute('href')).toBe('/cs/crm/customers');
  historyCanGoBack.current = true;
  await user.click(back);
  expect(historyBackMock).toHaveBeenCalledTimes(1);
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
    expect(pageSource).not.toMatch(/lookupCustomerAres|customer-ares|ARES/u);
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
