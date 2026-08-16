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
  ContactCreateFeature,
  classifyCreateContactError,
  customerDetailHref,
  decodeContactCreateId,
} from '../../src/routes/[lang]/crm/customers/[id]/contacts/new/page.tsx';

Object.assign(globalThis, {
  ULTRAMODERN_CRM_API_BASE_URL: 'http://localhost:4101/crm-api',
});

const { createContactMock, localeState, navigateMock, runEffectRequestMock } = rstest.hoisted(
  () => ({
    createContactMock: rstest.fn(),
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
  Link: ({ children, to, ...props }: { readonly children: ReactNode; readonly to: string }) => (
    <a {...props} href={to}>
      {children}
    </a>
  ),
  useNavigate: () => navigateMock,
  useParams: () => ({}),
}));

rstest.mock('../../src/api/crm-client.ts', () => ({
  createContact: createContactMock,
  runEffectRequest: runEffectRequestMock,
}));

rstest.mock('../../src/routes/ultramodern-route-head.tsx', () => ({
  UltramodernRouteHead: () => null,
}));

const customerId = '11111111-1111-4111-8111-111111111111';
const otherCustomerId = '22222222-2222-4222-8222-222222222222';
const contact = {
  archivedAt: null,
  contactId: '33333333-3333-4333-8333-333333333333',
  createdAt: '2026-08-16T08:00:00.000Z',
  customerId,
  email: 'ada@example.test',
  name: 'Ada Lovelace',
  phone: '123456789',
  updatedAt: '2026-08-16T08:00:00.000Z',
} as const;

const renderFeature = (
  options: { readonly id?: string | undefined; readonly writable?: boolean } = {},
) => {
  const id = 'id' in options ? options.id : customerId;
  const writable = options.writable ?? true;
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ContactCreateFeature routeParams={id === undefined ? {} : { id }} target={{ writable }} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    rerenderFeature: (nextId: string, nextWritable = writable) =>
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <ContactCreateFeature routeParams={{ id: nextId }} target={{ writable: nextWritable }} />
        </QueryClientProvider>,
      ),
  };
};

const fillForm = async (
  values: Readonly<{ name: string; email: string; phone: string }> = contact,
) => {
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: /^Contact name/u }), values.name);
  await user.type(screen.getByRole('textbox', { name: /^Email/u }), values.email);
  await user.type(screen.getByRole('textbox', { name: /^Phone/u }), values.phone);
  return user;
};

beforeEach(() => {
  localeState.current = 'en';
  navigateMock.mockResolvedValue();
  createContactMock.mockReturnValue(Effect.succeed(contact));
  runEffectRequestMock.mockImplementation((effect: Effect.Effect<unknown, unknown>) =>
    Effect.runPromise(effect),
  );
});

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

test('renders the empty ready form without loading the parent Customer', () => {
  renderFeature();

  expect(screen.getByRole('heading', { name: 'Create Contact' })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: /^Contact name/u }).getAttribute('value')).toBe('');
  expect(screen.getByRole('textbox', { name: /^Email/u }).getAttribute('value')).toBe('');
  expect(screen.getByRole('textbox', { name: /^Phone/u }).getAttribute('value')).toBe('');
  expect(screen.getByRole('link', { name: 'Back to Customer' }).getAttribute('href')).toBe(
    `/en/crm/customers/${customerId}`,
  );
  expect(createContactMock).not.toHaveBeenCalled();
});

test.each([undefined, 'not-a-uuid', 'x'.repeat(201)])(
  'rejects the invalid parent route value %s without exposing a form or mutation',
  (id) => {
    renderFeature({ id });

    expect(
      screen.getByText('This Customer was not found or is not available to you.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create Contact' })).toBeNull();
    expect(createContactMock).not.toHaveBeenCalled();
  },
);

test('decodes only bounded Customer UUIDs and builds the localized parent destination', () => {
  expect(decodeContactCreateId({ id: customerId })).toBe(customerId);
  expect(decodeContactCreateId({})).toBeUndefined();
  expect(decodeContactCreateId({ id: 'x'.repeat(201) })).toBeUndefined();
  expect(customerDetailHref('cs', customerId)).toBe(`/cs/crm/customers/${customerId}`);
});

test('keeps a non-writable target visible without an enabled mutation path', () => {
  renderFeature({ writable: false });

  expect(
    screen.getByText('CRM is currently read-only. A Contact cannot be created right now.'),
  ).toBeTruthy();
  expect(screen.getByRole('textbox', { name: /^Contact name/u }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByRole('textbox', { name: /^Email/u }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('textbox', { name: /^Phone/u }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Create Contact' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(createContactMock).not.toHaveBeenCalled();
});

test('submits the exact normalized payload through the generated client and navigates to the parent', async () => {
  renderFeature();
  const user = await fillForm({
    ...contact,
    email: 'Ada@Example.Test',
    name: '  Ada Lovelace  ',
    phone: ' 123456789 ',
  });

  await user.click(screen.getByRole('button', { name: 'Create Contact' }));

  await waitFor(() =>
    expect(navigateMock).toHaveBeenCalledWith({ to: `/en/crm/customers/${customerId}` }),
  );
  expect(createContactMock).toHaveBeenCalledWith(
    {
      customerId,
      email: 'Ada@Example.Test',
      name: 'Ada Lovelace',
      phone: '123456789',
    },
    {
      baseUrl: 'http://localhost:4101/crm-api',
      correlationId: expect.any(String),
      idempotencyKey: expect.any(String),
      locale: 'en',
    },
  );
  expect(runEffectRequestMock).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Contact created.')).toBeTruthy();
});

test('shows the pending state and permits only one semantic mutation', async () => {
  createContactMock.mockReturnValue(Effect.never);
  renderFeature();
  const user = await fillForm();
  const submit = screen.getByRole('button', { name: 'Create Contact' });

  await user.dblClick(submit);

  await waitFor(() => expect(createContactMock).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: 'Creating Contact…' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByRole('textbox', { name: /^Contact name/u }).hasAttribute('disabled')).toBe(
    true,
  );
});

test('reuses an idempotency key only for an uncertain unchanged retry and refreshes correlation', async () => {
  createContactMock
    .mockReturnValueOnce(
      Effect.fail({ _tag: 'HttpClientError', reason: { _tag: 'TransportError' } } as never),
    )
    .mockReturnValueOnce(Effect.succeed(contact));
  renderFeature();
  const user = await fillForm();

  await user.click(screen.getByRole('button', { name: 'Create Contact' }));
  await screen.findByText(/request may have completed/u);
  await user.click(screen.getByRole('button', { name: 'Create Contact' }));
  await waitFor(() => expect(createContactMock).toHaveBeenCalledTimes(2));

  const firstOptions = createContactMock.mock.calls[0]?.[1];
  const secondOptions = createContactMock.mock.calls[1]?.[1];
  expect(secondOptions.idempotencyKey).toBe(firstOptions.idempotencyKey);
  expect(secondOptions.correlationId).not.toBe(firstOptions.correlationId);
});

test('creates a new key after an uncertain intent changes', async () => {
  createContactMock.mockReturnValue(Effect.fail({ _tag: 'CrmUnavailableProblem' } as never));
  renderFeature();
  const user = await fillForm();

  await user.click(screen.getByRole('button', { name: 'Create Contact' }));
  await screen.findByText(/temporarily unavailable/u);
  await user.type(screen.getByRole('textbox', { name: /^Contact name/u }), ' Jr.');
  await user.click(screen.getByRole('button', { name: 'Create Contact' }));
  await waitFor(() => expect(createContactMock).toHaveBeenCalledTimes(2));

  expect(createContactMock.mock.calls[1]?.[1].idempotencyKey).not.toBe(
    createContactMock.mock.calls[0]?.[1].idempotencyKey,
  );
  expect(createContactMock.mock.calls[1]?.[1].correlationId).not.toBe(
    createContactMock.mock.calls[0]?.[1].correlationId,
  );
});

test('creates a new key when the parent Customer changes after an uncertain failure', async () => {
  createContactMock.mockReturnValue(Effect.fail({ _tag: 'GatewayUnavailableProblem' } as never));
  const view = renderFeature();
  const user = await fillForm();
  await user.click(screen.getByRole('button', { name: 'Create Contact' }));
  await screen.findByText(/temporarily unavailable/u);

  view.rerenderFeature(otherCustomerId);
  await user.click(screen.getByRole('button', { name: 'Create Contact' }));
  await waitFor(() => expect(createContactMock).toHaveBeenCalledTimes(2));

  expect(createContactMock.mock.calls[1]?.[0].customerId).toBe(otherCustomerId);
  expect(createContactMock.mock.calls[1]?.[1].idempotencyKey).not.toBe(
    createContactMock.mock.calls[0]?.[1].idempotencyKey,
  );
});

test('creates a fresh key after a definite failure without changing values', async () => {
  createContactMock.mockReturnValue(Effect.fail({ _tag: 'CrmForbiddenProblem' } as never));
  renderFeature();
  const user = await fillForm();
  await user.click(screen.getByRole('button', { name: 'Create Contact' }));
  await screen.findByText('You do not have permission to create a Contact for this Customer.');
  await user.click(screen.getByRole('button', { name: 'Create Contact' }));
  await waitFor(() => expect(createContactMock).toHaveBeenCalledTimes(2));

  expect(createContactMock.mock.calls[1]?.[1].idempotencyKey).not.toBe(
    createContactMock.mock.calls[0]?.[1].idempotencyKey,
  );
});

test.each([
  ['CrmInvalidRequestProblem', 'The Contact details were rejected.'],
  ['CrmAuthenticationProblem', 'Your session expired before the Contact could be created.'],
  ['CrmForbiddenProblem', 'You do not have permission to create a Contact for this Customer.'],
  ['CrmNotFoundProblem', 'This Customer no longer exists or is not available to you.'],
  ['CrmConflictProblem', 'The Contact could not be created because the request conflicts'],
  ['CrmInternalProblem', 'The Contact could not be created safely.'],
] as const)('maps the %s failure, retains values, and does not navigate', async (tag, message) => {
  createContactMock.mockReturnValue(Effect.fail({ _tag: tag } as never));
  renderFeature();
  const user = await fillForm();

  await user.click(screen.getByRole('button', { name: 'Create Contact' }));

  expect(await screen.findByText(new RegExp(message, 'u'))).toBeTruthy();
  expect(screen.getByRole('textbox', { name: /^Contact name/u }).getAttribute('value')).toBe(
    contact.name,
  );
  expect(navigateMock).not.toHaveBeenCalled();
});

test('maps the complete typed client error union to a closed presentation vocabulary', () => {
  expect(classifyCreateContactError({ _tag: 'CrmInvalidRequestProblem' } as never)).toEqual({
    state: 'invalid_form',
  });
  expect(
    classifyCreateContactError({ _tag: 'GatewayAuthenticationRequiredProblem' } as never),
  ).toEqual({
    state: 'authentication_expired',
  });
  expect(classifyCreateContactError({ _tag: 'GatewayForbiddenProblem' } as never)).toEqual({
    state: 'forbidden',
  });
  expect(classifyCreateContactError({ _tag: 'CrmForbiddenProblem' } as never)).toEqual({
    state: 'forbidden',
  });
  expect(classifyCreateContactError({ _tag: 'CrmNotFoundProblem' } as never)).toEqual({
    state: 'not_found',
  });
  expect(classifyCreateContactError({ _tag: 'CrmPreconditionRequiredProblem' } as never)).toEqual({
    state: 'conflict',
  });
  expect(classifyCreateContactError({ _tag: 'CrmConflictProblem' } as never)).toEqual({
    state: 'conflict',
  });
  expect(classifyCreateContactError({ _tag: 'GatewayRateLimitedProblem' } as never)).toEqual({
    reason: 'backend',
    state: 'unavailable',
    uncertain: true,
  });
  for (const tag of ['CrmUnavailableProblem', 'GatewayUnavailableProblem'] as const) {
    expect(classifyCreateContactError({ _tag: tag } as never)).toEqual({
      reason: 'backend',
      state: 'unavailable',
      uncertain: true,
    });
  }
  expect(
    classifyCreateContactError({
      _tag: 'HttpClientError',
      reason: { _tag: 'TransportError' },
    } as never),
  ).toEqual({ reason: 'transport', state: 'unavailable', uncertain: true });
  expect(
    classifyCreateContactError({
      _tag: 'HttpClientError',
      reason: { _tag: 'EmptyBodyError' },
    } as never),
  ).toEqual({ reason: 'decode', state: 'unavailable', uncertain: true });
  expect(
    classifyCreateContactError({
      _tag: 'HttpClientError',
      reason: { _tag: 'DecodeError' },
    } as never),
  ).toEqual({ reason: 'decode', state: 'unavailable', uncertain: true });
  expect(classifyCreateContactError({ _tag: 'SchemaError' } as never)).toEqual({
    reason: 'decode',
    state: 'unavailable',
    uncertain: true,
  });
  expect(classifyCreateContactError({ _tag: 'GatewayAudienceInvalidProblem' } as never)).toEqual({
    state: 'unexpected',
  });
  for (const tag of ['CrmInternalProblem', 'GatewayInternalProblem'] as const) {
    expect(classifyCreateContactError({ _tag: tag } as never)).toEqual({ state: 'unexpected' });
  }
  expect(
    classifyCreateContactError({
      _tag: 'HttpClientError',
      reason: { _tag: 'UnexpectedError' },
    } as never),
  ).toEqual({ state: 'unexpected' });
});

test('Back and Cancel use the localized parent route without invoking the mutation', async () => {
  localeState.current = 'cs';
  renderFeature();
  const user = userEvent.setup();

  expect(screen.getByRole('heading', { name: 'Vytvořit kontakt' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Zpět k zákazníkovi' }).getAttribute('href')).toBe(
    `/cs/crm/customers/${customerId}`,
  );
  await user.click(screen.getByRole('button', { name: 'Zrušit' }));
  expect(navigateMock).toHaveBeenCalledWith({ to: `/cs/crm/customers/${customerId}` });
  expect(createContactMock).not.toHaveBeenCalled();
});

describe('generated boundaries and localization', () => {
  test('keeps the form private and the page behind exact owner/Shell wiring', () => {
    const pageSource = readFileSync(
      new URL('../../src/routes/[lang]/crm/customers/[id]/contacts/new/page.tsx', import.meta.url),
      'utf-8',
    );
    const formSource = readFileSync(
      new URL('../../src/features/contacts/contact-form.tsx', import.meta.url),
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
    expect(pageSource).toContain('createContact(');
    expect(pageSource).not.toMatch(
      /\bfetch\s*\(|getCustomerDetail|api\/index|create-contact\.action|persistence\.service|src\/db/u,
    );
    expect(manifest).toContain("contributionKey: 'crm.core.page.contact-create'");
    expect(manifest).toContain("routePath: '/crm/customers/:id/contacts/new'");
    expect(manifest).not.toContain('crm.core.navigation.contact-create');
    expect(registration).toMatch(/'page-contact-create': \(\) =>\s*import\(/u);
    expect(federation).toContain("'./PageContactCreate'");
    expect(manifest).not.toContain('contact-form');
    expect(registration).not.toContain('contact-form');
    expect(formSource).not.toMatch(/crm-client|routeParams|customerId|target\.writable/u);
  });

  test('keeps English and Czech ContactCreate locale structures in parity', () => {
    expect(flattenKeys(csCatalog.crm.pages.contactCreate)).toEqual(
      flattenKeys(enCatalog.crm.pages.contactCreate),
    );
  });
});
