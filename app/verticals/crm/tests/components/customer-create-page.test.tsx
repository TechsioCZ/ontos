// @effect-diagnostics asyncFunction:off anyUnknownInErrorContext:off nodeBuiltinImport:off
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, rstest, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Effect } from 'effect';
import type { ReactNode } from 'react';
import csCatalog from '../../locales/cs/crm.json';
import enCatalog from '../../locales/en/crm.json';
import {
  CustomerCreateFeature,
  classifyCustomerAresLookupError,
  classifyCreateCustomerError,
} from '../../src/routes/[lang]/crm/customers/[id]/new/page.tsx';

Object.assign(globalThis, {
  ULTRAMODERN_CRM_API_BASE_URL: 'http://localhost:4101/crm-api',
});

const {
  createCustomerMock,
  executeCustomerAresLookupMock,
  legacyExecuteCustomerAresLookupMock,
  localeState,
  navigateMock,
  runEffectRequestMock,
} = rstest.hoisted(() => ({
  createCustomerMock: rstest.fn(),
  executeCustomerAresLookupMock: rstest.fn(),
  legacyExecuteCustomerAresLookupMock: rstest.fn(),
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
  useParams: () => ({ id: 'route-customer-context' }),
}));

rstest.mock('../../src/api/crm-client.ts', () => ({
  createCustomer: createCustomerMock,
  lookupCustomerAres: executeCustomerAresLookupMock,
  runEffectRequest: runEffectRequestMock,
}));

rstest.mock('../../src/api/customer-ares-lookup-client.ts', () => ({
  executeCustomerAresLookup: legacyExecuteCustomerAresLookupMock,
}));

rstest.mock('../../src/routes/ultramodern-route-head.tsx', () => ({
  UltramodernRouteHead: () => null,
}));

const createdCustomer = {
  archivedAt: null,
  createdAt: '2026-08-16T08:15:00.000Z',
  customerId: '11111111-1111-4111-8111-111111111111',
  dic: null,
  dissolvedOn: null,
  establishedOn: null,
  ico: null,
  legalFormCode: null,
  name: 'Acme Property Group',
  updatedAt: '2026-08-16T08:15:00.000Z',
} as const;

const aresCustomer = {
  dic: 'CZ48039101',
  dissolvedOn: null,
  establishedOn: '1992-12-04',
  ico: '48039101',
  legalFormCode: '112',
  name: 'J.E.S., spol. s r.o.',
} as const;

const getAresForm = () => screen.getByRole('form', { name: /ARES/u });
const getAresIco = () => within(getAresForm()).getByRole('textbox', { name: /^IČO/u });
const getCustomerIco = () =>
  document.querySelector<HTMLInputElement>('#customer-ico') as HTMLInputElement;

const renderFeature = ({ writable = true }: { readonly writable?: boolean } = {}) => {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CustomerCreateFeature
        routeParams={{ id: 'untrusted-route-context' }}
        target={{ writable }}
      />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  localeState.current = 'en';
  navigateMock.mockResolvedValue();
  createCustomerMock.mockReturnValue(Effect.succeed(createdCustomer));
  executeCustomerAresLookupMock.mockReturnValue(Effect.succeed(aresCustomer));
  legacyExecuteCustomerAresLookupMock.mockReturnValue(Effect.succeed(aresCustomer));
  runEffectRequestMock.mockImplementation((effect: Effect.Effect<unknown, unknown>) =>
    Effect.runPromise(effect),
  );
});

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

test('composes the existing form with empty localized create values and accessible validation', async () => {
  const user = userEvent.setup();
  renderFeature();

  expect(screen.getByRole('heading', { name: 'Create Customer' })).toBeTruthy();
  expect(document.querySelectorAll('form')).toHaveLength(2);
  const name = screen.getByRole('textbox', { name: /^Customer name/u });
  expect(name.getAttribute('value')).toBe('');
  await user.click(screen.getByRole('button', { name: 'Create Customer' }));

  expect(document.activeElement).toBe(name);
  expect(name.getAttribute('aria-invalid')).toBe('true');
  expect(name.getAttribute('aria-describedby')).toBe('customer-name-error');
  expect(screen.getByText('Enter a Customer name.')).toBeTruthy();
  expect(createCustomerMock).not.toHaveBeenCalled();
});

test('emits no lookup before valid loader intent and calls the composed CRM client exactly', async () => {
  const user = userEvent.setup();
  renderFeature();
  const ico = getAresIco();

  await user.type(ico, '123');
  await user.click(within(getAresForm()).getByRole('button', { name: 'Load from ARES' }));
  expect(executeCustomerAresLookupMock).not.toHaveBeenCalled();
  expect(createCustomerMock).not.toHaveBeenCalled();

  await user.clear(ico);
  await user.type(ico, aresCustomer.ico);
  await user.keyboard('{Enter}');

  await waitFor(() => expect(executeCustomerAresLookupMock).toHaveBeenCalledTimes(1));
  expect(executeCustomerAresLookupMock).toHaveBeenCalledWith(
    { ico: aresCustomer.ico },
    {
      baseUrl: 'http://localhost:4101/crm-api',
      correlationId: expect.any(String),
    },
  );
  expect(createCustomerMock).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: /^Customer name/u }).getAttribute('value')).toBe(
    aresCustomer.name,
  );
  expect(getCustomerIco().value).toBe(aresCustomer.ico);
  expect(
    screen.getByText(
      'Customer details loaded from ARES. Review and edit them before creating the Customer.',
    ),
  ).toBeTruthy();
});

test('routes ARES lookup through the composed CRM client instead of decoding the page response', async () => {
  localeState.current = 'cs';
  legacyExecuteCustomerAresLookupMock.mockReturnValue(
    Effect.fail({ _tag: 'HttpClientError', reason: { _tag: 'DecodeError' } } as never),
  );
  const user = userEvent.setup();
  renderFeature();

  await user.type(getAresIco(), aresCustomer.ico);
  await user.keyboard('{Enter}');

  expect(await screen.findByText(/Údaje zákazníka byly načteny z ARES/u)).toBeTruthy();
  expect(screen.queryByText('Odpověď ARES se nepodařilo přečíst. Zkuste to znovu.')).toBeNull();
  expect(executeCustomerAresLookupMock).toHaveBeenCalledWith(
    { ico: aresCustomer.ico },
    {
      baseUrl: 'http://localhost:4101/crm-api',
      correlationId: expect.any(String),
    },
  );
  expect(legacyExecuteCustomerAresLookupMock).not.toHaveBeenCalled();
});

test('replaces canonical fields, retains omitted optional values, and replaces supplied optionals', async () => {
  executeCustomerAresLookupMock
    .mockReturnValueOnce(
      Effect.succeed({
        dic: null,
        dissolvedOn: null,
        establishedOn: null,
        ico: '48039101',
        legalFormCode: null,
        name: 'First ARES name',
      }),
    )
    .mockReturnValueOnce(
      Effect.succeed({
        dic: 'CZ00123456',
        dissolvedOn: '2026-08-17',
        establishedOn: '2020-01-02',
        ico: '00123456',
        legalFormCode: '112',
        name: 'Second ARES name',
      }),
    );
  const user = userEvent.setup();
  renderFeature();
  await user.type(screen.getByRole('textbox', { name: /^Customer name/u }), 'Manual name');
  await user.type(getCustomerIco(), '99999999');
  await user.type(screen.getByRole('textbox', { name: /^DIČ/u }), 'CZMANUAL');
  await user.type(screen.getByRole('textbox', { name: /^Legal-form code/u }), '101');
  await user.type(screen.getByLabelText('Establishment date'), '2019-01-02');
  await user.type(screen.getByLabelText('Dissolution date'), '2025-01-02');

  await user.type(getAresIco(), '48039101');
  await user.keyboard('{Enter}');
  await screen.findByText(/Customer details loaded from ARES/u);

  expect(screen.getByRole('textbox', { name: /^Customer name/u }).getAttribute('value')).toBe(
    'First ARES name',
  );
  expect(getCustomerIco().value).toBe('48039101');
  expect(screen.getByRole('textbox', { name: /^DIČ/u }).getAttribute('value')).toBe('CZMANUAL');
  expect(screen.getByRole('textbox', { name: /^Legal-form code/u }).getAttribute('value')).toBe(
    '101',
  );
  expect((screen.getByLabelText('Establishment date') as HTMLInputElement).value).toBe(
    '2019-01-02',
  );
  expect((screen.getByLabelText('Dissolution date') as HTMLInputElement).value).toBe('2025-01-02');

  await user.clear(getAresIco());
  await user.type(getAresIco(), '00123456');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(executeCustomerAresLookupMock).toHaveBeenCalledTimes(2));

  expect(screen.getByRole('textbox', { name: /^Customer name/u }).getAttribute('value')).toBe(
    'Second ARES name',
  );
  expect(getCustomerIco().value).toBe('00123456');
  expect(screen.getByRole('textbox', { name: /^DIČ/u }).getAttribute('value')).toBe('CZ00123456');
  expect(screen.getByRole('textbox', { name: /^Legal-form code/u }).getAttribute('value')).toBe(
    '112',
  );
  expect((screen.getByLabelText('Establishment date') as HTMLInputElement).value).toBe(
    '2020-01-02',
  );
  expect((screen.getByLabelText('Dissolution date') as HTMLInputElement).value).toBe('2026-08-17');
});

test('keeps ARES-prefilled fields editable and creates only the final canonical flat payload', async () => {
  const user = userEvent.setup();
  renderFeature();
  await user.type(getAresIco(), aresCustomer.ico);
  await user.keyboard('{Enter}');
  await screen.findByText(/Customer details loaded from ARES/u);

  const name = screen.getByRole('textbox', { name: /^Customer name/u });
  await user.clear(name);
  await user.type(name, 'Reviewed Customer');
  const dic = screen.getByRole('textbox', { name: /^DIČ/u });
  await user.clear(dic);
  await user.type(dic, 'czreviewed');
  await user.click(screen.getByRole('button', { name: 'Create Customer' }));

  await waitFor(() => expect(createCustomerMock).toHaveBeenCalledTimes(1));
  expect(createCustomerMock.mock.calls[0]?.[0]).toEqual({
    dic: 'CZREVIEWED',
    dissolvedOn: null,
    establishedOn: aresCustomer.establishedOn,
    ico: aresCustomer.ico,
    legalFormCode: aresCustomer.legalFormCode,
    name: 'Reviewed Customer',
  });
  expect(createCustomerMock.mock.calls[0]?.[0]).not.toHaveProperty('address');
  expect(createCustomerMock.mock.calls[0]?.[0]).not.toHaveProperty('ares');
  expect(createCustomerMock.mock.calls[0]?.[0]).not.toHaveProperty('source');
  expect(createCustomerMock.mock.calls[0]?.[0]).not.toHaveProperty('upload');
  expect(navigateMock).toHaveBeenCalledWith({ to: '/en/crm/customers' });
});

test('submits one normalized keyboard intent through the generated client without route context', async () => {
  const user = userEvent.setup();
  renderFeature();
  const name = screen.getByRole('textbox', { name: /^Customer name/u });
  await user.type(name, '  Acme Property Group  ');
  await user.keyboard('{Enter}');

  await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/en/crm/customers' }));
  expect(createCustomerMock).toHaveBeenCalledTimes(1);
  expect(createCustomerMock).toHaveBeenCalledWith(
    {
      dic: null,
      dissolvedOn: null,
      establishedOn: null,
      ico: null,
      legalFormCode: null,
      name: 'Acme Property Group',
    },
    {
      baseUrl: 'http://localhost:4101/crm-api',
      correlationId: expect.any(String),
      idempotencyKey: expect.any(String),
      locale: 'en',
    },
  );
  expect(createCustomerMock.mock.calls[0]?.[0]).not.toHaveProperty('id');
  expect(screen.getByRole('status').textContent).toBe('Customer created.');
});

test('suppresses duplicate mutations and disables all form controls while pending', async () => {
  createCustomerMock.mockReturnValue(Effect.never);
  const user = userEvent.setup();
  renderFeature();
  await user.type(screen.getByRole('textbox', { name: /^Customer name/u }), 'Acme');
  await user.dblClick(screen.getByRole('button', { name: 'Create Customer' }));

  await waitFor(() => expect(createCustomerMock).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('textbox', { name: /^Customer name/u }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByRole('button', { name: 'Creating Customer…' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
});

test('prevents creation while an ARES lookup is pending', async () => {
  executeCustomerAresLookupMock.mockReturnValue(Effect.never);
  const user = userEvent.setup();
  renderFeature();
  await user.type(getAresIco(), aresCustomer.ico);
  await user.keyboard('{Enter}');

  await waitFor(() => expect(executeCustomerAresLookupMock).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('textbox', { name: /^Customer name/u }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByRole('button', { name: 'Create Customer' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(createCustomerMock).not.toHaveBeenCalled();
});

test('keeps lookup readable while a non-writable target disables only creation', async () => {
  const user = userEvent.setup();
  renderFeature({ writable: false });

  expect(
    screen.getByText('CRM is currently read-only. You cannot create a Customer.'),
  ).toBeTruthy();
  expect(screen.getByRole('textbox', { name: /^Customer name/u }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByRole('button', { name: 'Create Customer' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(getAresIco().hasAttribute('disabled')).toBe(false);
  await user.type(getAresIco(), aresCustomer.ico);
  await user.keyboard('{Enter}');
  await waitFor(() => expect(executeCustomerAresLookupMock).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('textbox', { name: /^Customer name/u }).getAttribute('value')).toBe(
    aresCustomer.name,
  );
  expect(createCustomerMock).not.toHaveBeenCalled();
});

test('reuses an idempotency key only for an uncertain retry of the same normalized intent', async () => {
  createCustomerMock
    .mockReturnValueOnce(
      Effect.fail({ _tag: 'HttpClientError', reason: { _tag: 'TransportError' } } as never),
    )
    .mockReturnValueOnce(Effect.succeed(createdCustomer));
  const user = userEvent.setup();
  renderFeature();
  await user.type(screen.getByRole('textbox', { name: /^Customer name/u }), 'Acme');

  await user.click(screen.getByRole('button', { name: 'Create Customer' }));
  expect(
    await screen.findByText(
      'The Customer service could not be reached. Check your connection and try again.',
    ),
  ).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Create Customer' }));
  await waitFor(() => expect(createCustomerMock).toHaveBeenCalledTimes(2));

  const firstOptions = createCustomerMock.mock.calls[0]?.[1];
  const secondOptions = createCustomerMock.mock.calls[1]?.[1];
  expect(secondOptions.idempotencyKey).toBe(firstOptions.idempotencyKey);
  expect(secondOptions.correlationId).not.toBe(firstOptions.correlationId);
});

test('creates a new idempotency key after any Customer field changes an uncertain intent', async () => {
  createCustomerMock.mockReturnValue(Effect.fail({ _tag: 'CrmUnavailableProblem' } as never));
  const user = userEvent.setup();
  renderFeature();
  const name = screen.getByRole('textbox', { name: /^Customer name/u });
  await user.type(name, 'Acme');

  await user.click(screen.getByRole('button', { name: 'Create Customer' }));
  await screen.findByText('The Customer service is temporarily unavailable. Try again.');
  await user.type(getCustomerIco(), '00123456');
  await user.click(screen.getByRole('button', { name: 'Create Customer' }));
  await waitFor(() => expect(createCustomerMock).toHaveBeenCalledTimes(2));

  expect(createCustomerMock.mock.calls[1]?.[1].idempotencyKey).not.toBe(
    createCustomerMock.mock.calls[0]?.[1].idempotencyKey,
  );
});

test('creates a new idempotency key after a definite terminal failure', async () => {
  createCustomerMock.mockReturnValue(Effect.fail({ _tag: 'CrmConflictProblem' } as never));
  const user = userEvent.setup();
  renderFeature();
  await user.type(screen.getByRole('textbox', { name: /^Customer name/u }), 'Acme');

  await user.click(screen.getByRole('button', { name: 'Create Customer' }));
  await screen.findByText(
    'This request conflicts with a previous Customer creation attempt. Review the name and try again.',
  );
  await user.click(screen.getByRole('button', { name: 'Create Customer' }));
  await waitFor(() => expect(createCustomerMock).toHaveBeenCalledTimes(2));

  expect(createCustomerMock.mock.calls[1]?.[1].idempotencyKey).not.toBe(
    createCustomerMock.mock.calls[0]?.[1].idempotencyKey,
  );
});

test.each([
  ['CrmInvalidRequestProblem', 'Enter a valid Customer name.'],
  ['CrmAuthenticationProblem', 'Your session expired before the Customer could be created.'],
  ['CrmForbiddenProblem', 'You do not have permission to create Customers.'],
  [
    'CrmConflictProblem',
    'This request conflicts with a previous Customer creation attempt. Review the name and try again.',
  ],
  ['CrmInternalProblem', 'The Customer could not be created safely. Try again.'],
] as const)(
  'maps the %s mutation failure into the form without navigating',
  async (tag, message) => {
    createCustomerMock.mockReturnValue(Effect.fail({ _tag: tag } as never));
    const user = userEvent.setup();
    renderFeature();
    await user.type(screen.getByRole('textbox', { name: /^Customer name/u }), 'Acme');

    await user.click(screen.getByRole('button', { name: 'Create Customer' }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(navigateMock).not.toHaveBeenCalled();
  },
);

test('maps the complete client failure families to a closed presentation vocabulary', () => {
  const cases = [
    [{ _tag: 'CrmInvalidRequestProblem' }, { state: 'name_invalid' }],
    [{ _tag: 'CrmAuthenticationProblem' }, { state: 'authentication_expired' }],
    [{ _tag: 'GatewayAuthenticationRequiredProblem' }, { state: 'authentication_expired' }],
    [{ _tag: 'CrmForbiddenProblem' }, { state: 'forbidden' }],
    [{ _tag: 'GatewayForbiddenProblem' }, { state: 'forbidden' }],
    [{ _tag: 'CrmConflictProblem' }, { state: 'conflict' }],
    [{ _tag: 'CrmPreconditionRequiredProblem' }, { state: 'conflict' }],
    [
      { _tag: 'CrmUnavailableProblem' },
      { reason: 'backend', state: 'unavailable', uncertain: true },
    ],
    [
      { _tag: 'GatewayRateLimitedProblem' },
      { reason: 'backend', state: 'unavailable', uncertain: true },
    ],
    [
      { _tag: 'GatewayUnavailableProblem' },
      { reason: 'backend', state: 'unavailable', uncertain: true },
    ],
    [{ _tag: 'SchemaError' }, { reason: 'decode', state: 'unavailable', uncertain: true }],
    [
      { _tag: 'HttpClientError', reason: { _tag: 'DecodeError' } },
      { reason: 'decode', state: 'unavailable', uncertain: true },
    ],
    [
      { _tag: 'HttpClientError', reason: { _tag: 'EmptyBodyError' } },
      { reason: 'decode', state: 'unavailable', uncertain: true },
    ],
    [
      { _tag: 'HttpClientError', reason: { _tag: 'TransportError' } },
      { reason: 'transport', state: 'unavailable', uncertain: true },
    ],
    [{ _tag: 'CrmInternalProblem' }, { state: 'unexpected' }],
    [{ _tag: 'GatewayAudienceInvalidProblem' }, { state: 'unexpected' }],
    [{ _tag: 'GatewayInternalProblem' }, { state: 'unexpected' }],
    [{ _tag: 'HttpClientError', reason: { _tag: 'UnexpectedError' } }, { state: 'unexpected' }],
  ] as const;

  for (const [error, expected] of cases) {
    expect(classifyCreateCustomerError(error as never)).toEqual(expected);
  }
});

test.each([
  ['CustomerAresLookupInvalidProblem', 'Enter an IČO containing exactly eight digits.', 1],
  [
    'CustomerAresLookupAuthenticationProblem',
    'Your session expired before ARES could be searched.',
    1,
  ],
  [
    'CustomerAresLookupForbiddenProblem',
    'You do not have permission to look up Customer data in ARES.',
    1,
  ],
  ['CustomerAresLookupNotFoundProblem', 'ARES has no economic subject for this IČO.', 1],
  ['CustomerAresLookupUnavailableProblem', 'ARES is temporarily unavailable. Try again.', 2],
  [
    'CustomerAresLookupInternalProblem',
    'The ARES lookup could not be completed safely. Try again.',
    1,
  ],
] as const)(
  'maps the %s lookup failure to an isolated accessible loader state',
  async (tag, message, expectedCalls) => {
    executeCustomerAresLookupMock.mockReturnValue(Effect.fail({ _tag: tag } as never));
    const user = userEvent.setup();
    renderFeature();
    await user.type(getAresIco(), aresCustomer.ico);
    await user.keyboard('{Enter}');

    expect(await screen.findByText(message)).toBeTruthy();
    expect(executeCustomerAresLookupMock).toHaveBeenCalledTimes(expectedCalls);
    expect(createCustomerMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: /^Customer name/u }).getAttribute('value')).toBe('');
  },
);

test.each([
  [
    { _tag: 'SchemaError' },
    'The ARES response could not be read. Try again.',
    { reason: 'decode', state: 'unavailable', uncertain: true },
  ],
  [
    { _tag: 'HttpClientError', reason: { _tag: 'DecodeError' } },
    'The ARES response could not be read. Try again.',
    { reason: 'decode', state: 'unavailable', uncertain: true },
  ],
  [
    { _tag: 'HttpClientError', reason: { _tag: 'TransportError' } },
    'ARES could not be reached. Check your connection and try again.',
    { reason: 'transport', state: 'unavailable', uncertain: true },
  ],
] as const)(
  'maps and bounds uncertain lookup client failures %#',
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Parameterized Rstest cases use an async callback to exercise the rendered mutation lifecycle.
  async (error, message, expectedState) => {
    executeCustomerAresLookupMock.mockReturnValue(Effect.fail(error as never));
    const user = userEvent.setup();
    renderFeature();
    await user.type(getAresIco(), aresCustomer.ico);
    await user.keyboard('{Enter}');

    expect(await screen.findByText(message)).toBeTruthy();
    expect(executeCustomerAresLookupMock).toHaveBeenCalledTimes(2);
    expect(classifyCustomerAresLookupError(error as never)).toEqual(expectedState);
    expect(within(getAresForm()).getByRole('button', { name: 'Try ARES again' })).toBeTruthy();
  },
);

test('retries only an uncertain lookup once with fresh correlation and clears stale failure', async () => {
  executeCustomerAresLookupMock
    .mockReturnValueOnce(Effect.fail({ _tag: 'CustomerAresLookupUnavailableProblem' } as never))
    .mockReturnValueOnce(Effect.succeed(aresCustomer));
  const user = userEvent.setup();
  renderFeature();
  await user.type(getAresIco(), aresCustomer.ico);
  await user.keyboard('{Enter}');

  expect(await screen.findByText(/Customer details loaded from ARES/u)).toBeTruthy();
  expect(executeCustomerAresLookupMock).toHaveBeenCalledTimes(2);
  expect(executeCustomerAresLookupMock.mock.calls[1]?.[1]?.correlationId).not.toBe(
    executeCustomerAresLookupMock.mock.calls[0]?.[1]?.correlationId,
  );
  expect(screen.queryByText('ARES is temporarily unavailable. Try again.')).toBeNull();
});

test('maps the complete lookup client error union to a closed presentation vocabulary', () => {
  const cases = [
    [{ _tag: 'CustomerAresLookupInvalidProblem' }, { state: 'invalid' }],
    [{ _tag: 'CustomerAresLookupAuthenticationProblem' }, { state: 'authentication_expired' }],
    [{ _tag: 'GatewayAuthenticationRequiredProblem' }, { state: 'authentication_expired' }],
    [{ _tag: 'CustomerAresLookupForbiddenProblem' }, { state: 'forbidden' }],
    [{ _tag: 'GatewayForbiddenProblem' }, { state: 'forbidden' }],
    [{ _tag: 'CustomerAresLookupNotFoundProblem' }, { state: 'not_found' }],
    [
      { _tag: 'CustomerAresLookupUnavailableProblem' },
      { reason: 'backend', state: 'unavailable', uncertain: true },
    ],
    [
      { _tag: 'GatewayRateLimitedProblem' },
      { reason: 'backend', state: 'unavailable', uncertain: true },
    ],
    [
      { _tag: 'GatewayUnavailableProblem' },
      { reason: 'backend', state: 'unavailable', uncertain: true },
    ],
    [{ _tag: 'SchemaError' }, { reason: 'decode', state: 'unavailable', uncertain: true }],
    [
      { _tag: 'HttpClientError', reason: { _tag: 'DecodeError' } },
      { reason: 'decode', state: 'unavailable', uncertain: true },
    ],
    [
      { _tag: 'HttpClientError', reason: { _tag: 'EmptyBodyError' } },
      { reason: 'decode', state: 'unavailable', uncertain: true },
    ],
    [
      { _tag: 'HttpClientError', reason: { _tag: 'TransportError' } },
      { reason: 'transport', state: 'unavailable', uncertain: true },
    ],
    [{ _tag: 'CustomerAresLookupInternalProblem' }, { state: 'unexpected' }],
    [{ _tag: 'GatewayAudienceInvalidProblem' }, { state: 'unexpected' }],
    [{ _tag: 'GatewayInternalProblem' }, { state: 'unexpected' }],
    [{ _tag: 'HttpClientError', reason: { _tag: 'UnexpectedError' } }, { state: 'unexpected' }],
  ] as const;

  for (const [error, expected] of cases) {
    expect(classifyCustomerAresLookupError(error as never)).toEqual(expected);
  }
});

test('Back and Cancel use the localized Customers route without invoking a mutation', async () => {
  localeState.current = 'cs';
  const user = userEvent.setup();
  renderFeature();

  const back = screen.getByRole('link', { name: 'Zpět na zákazníky' });
  expect(back.getAttribute('href')).toBe('/cs/crm/customers');
  expect(screen.getByRole('heading', { name: 'Vytvořit zákazníka' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Zrušit' }));
  expect(navigateMock).toHaveBeenCalledWith({ to: '/cs/crm/customers' });
  expect(createCustomerMock).not.toHaveBeenCalled();
});

describe('generated boundaries and localization', () => {
  test('keeps creation behind the generated frontend, owner, federation, and Shell seams', () => {
    const pageSource = readFileSync(
      new URL('../../src/routes/[lang]/crm/customers/[id]/new/page.tsx', import.meta.url),
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
    const federationWrapper = readFileSync(
      new URL('../../src/federation/page-customer-create.tsx', import.meta.url),
      'utf-8',
    );
    const shellClient = readFileSync(
      new URL('../../../../apps/shell-super-app/src/api/vertical-clients.ts', import.meta.url),
      'utf-8',
    );
    const shellConnector = readFileSync(
      new URL(
        '../../../../apps/shell-super-app/src/routes/[lang]/crm/customers/[id]/new/page.data.ts',
        import.meta.url,
      ),
      'utf-8',
    );

    expect(pageSource).toContain('createCustomer(');
    expect(pageSource).toContain('lookupCustomerAres(');
    expect(pageSource).toContain('<CustomerAresLoader');
    expect(pageSource).toContain('values={formValues}');
    expect(pageSource).toContain('target={{ writable: false }}');
    expect(pageSource).not.toMatch(
      /\bfetch\s*\(|getCustomerDetail|api\/index|src\/actions|src\/db|src\/services|address|upload/u,
    );
    expect(manifest).toContain("contributionKey: 'crm.core.page.customer-create'");
    expect(manifest).toContain("routePath: '/crm/customers/:id/new'");
    expect(manifest).not.toContain('crm.core.navigation.customer-create');
    expect(registration).toContain("'page-customer-create': () => import(");
    expect(federation).toContain("'./PageCustomerCreate'");
    expect(federationWrapper).toContain(
      '<CustomerCreatePage routeParams={routeParams} target={target} />',
    );
    expect(shellClient).toContain("componentKey: 'crm.core.page-customer-create'");
    expect(shellConnector).toContain("const routeParameterNames = ['id'] as const");
    expect(shellConnector).toContain("entrypointKey: 'crm.core.page.customer-create'");
    expect(manifest).not.toContain('customer-form');
    expect(registration).not.toContain('customer-form');
  });

  test('keeps English and Czech CustomerCreate locale structures in parity', () => {
    expect(flattenKeys(csCatalog.crm.pages.customerCreate)).toEqual(
      flattenKeys(enCatalog.crm.pages.customerCreate),
    );
  });
});
