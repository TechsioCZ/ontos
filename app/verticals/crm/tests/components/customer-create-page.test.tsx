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
  CustomerCreateFeature,
  classifyCreateCustomerError,
} from '../../src/routes/[lang]/crm/customers/[id]/new/page.tsx';

Object.assign(globalThis, {
  ULTRAMODERN_CRM_API_BASE_URL: 'http://localhost:4101/crm-api',
});

const { createCustomerMock, localeState, navigateMock, runEffectRequestMock } = rstest.hoisted(
  () => ({
    createCustomerMock: rstest.fn(),
    localeState: { current: 'en' as 'cs' | 'en' },
    navigateMock: rstest.fn(() => Promise.resolve()),
    runEffectRequestMock: rstest.fn(),
  }),
);

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
  useParams: () => ({ id: 'route-customer-context' }),
}));

rstest.mock('../../src/api/crm-client.ts', () => ({
  createCustomer: createCustomerMock,
  runEffectRequest: runEffectRequestMock,
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
  const name = screen.getByRole('textbox', { name: /^Customer name/u });
  expect(name.getAttribute('value')).toBe('');
  await user.click(screen.getByRole('button', { name: 'Create Customer' }));

  expect(document.activeElement).toBe(name);
  expect(name.getAttribute('aria-invalid')).toBe('true');
  expect(name.getAttribute('aria-describedby')).toBe('customer-name-error');
  expect(screen.getByText('Enter a Customer name.')).toBeTruthy();
  expect(createCustomerMock).not.toHaveBeenCalled();
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
    { name: 'Acme Property Group' },
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

test('keeps a non-writable target visible without an enabled mutation path', () => {
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
  expect(createCustomerMock).not.toHaveBeenCalled();
});

test('reuses an idempotency key only for an uncertain retry of the same name', async () => {
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

test('creates a new idempotency key after the user changes an uncertain intent', async () => {
  createCustomerMock.mockReturnValue(Effect.fail({ _tag: 'CrmUnavailableProblem' } as never));
  const user = userEvent.setup();
  renderFeature();
  const name = screen.getByRole('textbox', { name: /^Customer name/u });
  await user.type(name, 'Acme');

  await user.click(screen.getByRole('button', { name: 'Create Customer' }));
  await screen.findByText('The Customer service is temporarily unavailable. Try again.');
  await user.type(name, ' Group');
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
    expect(pageSource).toContain("initialValues={{ name: '' }}");
    expect(pageSource).toContain('target={{ writable: false }}');
    expect(pageSource).not.toMatch(
      /\bfetch\s*\(|getCustomerDetail|api\/index|src\/actions|src\/db|src\/services/u,
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
