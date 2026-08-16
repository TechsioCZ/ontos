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
  ContactEditFeature,
  classifyContactEditDetailError,
  classifyEditContactError,
  contactDetailHref,
  contactEditDetailQueryKey,
  decodeContactEditRoute,
} from '../../src/routes/[lang]/crm/customers/[id]/contacts/[contactId]/edit/page.tsx';

Object.assign(globalThis, {
  ULTRAMODERN_CRM_API_BASE_URL: 'http://localhost:4101/crm-api',
});

const { editContactMock, getContactMock, localeState, navigateMock, runEffectRequestMock } =
  rstest.hoisted(() => ({
    editContactMock: rstest.fn(),
    getContactMock: rstest.fn(),
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
  Link: ({ children, to, ...props }: { readonly children: ReactNode; readonly to: string }) => (
    <a {...props} href={to}>
      {children}
    </a>
  ),
  useNavigate: () => navigateMock,
  useParams: () => ({}),
}));

rstest.mock('../../src/api/crm-client.ts', () => ({
  editContact: editContactMock,
  getContact: getContactMock,
  runEffectRequest: runEffectRequestMock,
}));

rstest.mock('../../src/routes/ultramodern-route-head.tsx', () => ({
  UltramodernRouteHead: () => null,
}));

const customerId = '11111111-1111-4111-8111-111111111111';
const otherCustomerId = '22222222-2222-4222-8222-222222222222';
const contactId = '33333333-3333-4333-8333-333333333333';
const otherContactId = '44444444-4444-4444-8444-444444444444';
const activeContact = {
  archivedAt: null,
  contactId,
  createdAt: '2026-08-13T08:15:00.000Z',
  customerId,
  email: 'Ada@Example.Test',
  name: 'Ada Lovelace',
  phone: '123456789',
  updatedAt: '2026-08-14T09:30:00.000Z',
} as const;
const archivedContact = {
  ...activeContact,
  archivedAt: '2026-08-14T10:00:00.000Z',
  name: 'Archived Contact',
} as const;
const updatedContact = {
  ...activeContact,
  email: 'grace@example.test',
  name: 'Grace Hopper',
  phone: '987654321',
  updatedAt: '2026-08-16T10:00:00.000Z',
} as const;

const renderFeature = (
  options: {
    readonly contactId?: string | undefined;
    readonly customerId?: string | undefined;
    readonly writable?: boolean;
  } = {},
) => {
  const routeContactId = 'contactId' in options ? options.contactId : contactId;
  const routeCustomerId = 'customerId' in options ? options.customerId : customerId;
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ContactEditFeature
        routeParams={{
          ...(routeContactId === undefined ? {} : { contactId: routeContactId }),
          ...(routeCustomerId === undefined ? {} : { id: routeCustomerId }),
        }}
        target={{ writable: options.writable ?? true }}
      />
    </QueryClientProvider>,
  );
  return queryClient;
};

beforeEach(() => {
  localeState.current = 'en';
  navigateMock.mockResolvedValue();
  getContactMock.mockReturnValue(Effect.succeed(activeContact));
  editContactMock.mockReturnValue(Effect.succeed(updatedContact));
  runEffectRequestMock.mockImplementation((effect: Effect.Effect<unknown, unknown>) =>
    Effect.runPromise(effect),
  );
});

afterEach(() => {
  cleanup();
  rstest.clearAllMocks();
});

describe('ContactEdit route and query boundary', () => {
  test('decodes only the bounded UUID pair and keeps the established hierarchical cache identity', () => {
    expect(decodeContactEditRoute({ contactId, id: customerId })).toEqual({
      contactId,
      customerId,
    });
    for (const routeParams of [
      {},
      { contactId },
      { id: customerId },
      { contactId: 'not-a-uuid', id: customerId },
      { contactId, id: 'x'.repeat(201) },
    ]) {
      expect(decodeContactEditRoute(routeParams)).toBeUndefined();
    }
    expect(contactEditDetailQueryKey(customerId, contactId)).toEqual([
      'crm',
      'customers',
      customerId,
      'contacts',
      'detail',
      contactId,
    ]);
    expect(contactDetailHref('cs', customerId, contactId)).toBe(
      `/cs/crm/customers/${customerId}/contacts/${contactId}`,
    );
  });

  test.each([
    { contactId: undefined, customerId: undefined },
    { contactId, customerId: undefined },
    { contactId: undefined, customerId },
    { contactId: 'not-a-contact', customerId },
    { contactId, customerId: 'x'.repeat(201) },
  ])('rejects invalid route input %j before exposing data or calling CRM', async (options) => {
    renderFeature(options);

    expect(
      await screen.findByText('This Contact could not be found for the selected Customer.'),
    ).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(getContactMock).not.toHaveBeenCalled();
    expect(editContactMock).not.toHaveBeenCalled();
  });

  test.each([activeContact, archivedContact])(
    'loads and prefills the existing reusable form for Contact $name',
    async (contact) => {
      getContactMock.mockReturnValue(Effect.succeed(contact));
      renderFeature();

      const name = await screen.findByRole('textbox', { name: /^Contact name/u });
      expect(name.getAttribute('value')).toBe(contact.name);
      expect(screen.getByRole('textbox', { name: /^Email/u }).getAttribute('value')).toBe(
        contact.email,
      );
      expect(screen.getByRole('textbox', { name: /^Phone/u }).getAttribute('value')).toBe(
        contact.phone,
      );
      expect(getContactMock).toHaveBeenCalledWith(
        { contactId },
        {
          baseUrl: 'http://localhost:4101/crm-api',
          correlationId: expect.any(String),
          locale: 'en',
        },
      );
      expect(runEffectRequestMock).toHaveBeenCalledTimes(1);
    },
  );

  test('renders accessible loading feedback without editable controls', () => {
    getContactMock.mockReturnValue(Effect.never);
    renderFeature();

    expect(screen.getByRole('status').textContent).toBe('Loading Contact details…');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByTestId('contact-edit-results').getAttribute('aria-busy')).toBe('true');
  });

  test('suppresses every Contact field and mutation when the parent does not match', async () => {
    getContactMock.mockReturnValue(
      Effect.succeed({ ...activeContact, customerId: otherCustomerId }),
    );
    renderFeature();

    expect(
      await screen.findByText('This Contact could not be found for the selected Customer.'),
    ).toBeTruthy();
    expect(screen.queryByText(activeContact.name)).toBeNull();
    expect(screen.queryByText(activeContact.email)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save Contact' })).toBeNull();
    expect(editContactMock).not.toHaveBeenCalled();
  });
});

describe('ContactEdit query states', () => {
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
    ['ContactDetailInternalProblem', 'The Contact could not be loaded safely. Try again.', true],
  ] as const)('renders the explicit %s state', async (tag, message, retryable) => {
    getContactMock.mockReturnValue(Effect.fail({ _tag: tag } as never));
    renderFeature();

    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' }) !== null).toBe(retryable);
  });

  test('bounds automatic retry for safe temporary read failures', async () => {
    getContactMock.mockReturnValue(
      Effect.fail({ _tag: 'ContactDetailUnavailableProblem' } as never),
    );
    renderFeature();

    expect(
      await screen.findByText('The Contact service is temporarily unavailable. Try again.'),
    ).toBeTruthy();
    expect(getContactMock).toHaveBeenCalledTimes(2);
  });

  test('retries from the keyboard and restores focus after a manual retry', async () => {
    getContactMock
      .mockReturnValueOnce(Effect.fail({ _tag: 'ContactDetailInternalProblem' } as never))
      .mockReturnValueOnce(Effect.succeed(activeContact));
    const user = userEvent.setup();
    renderFeature();

    const retry = await screen.findByRole('button', { name: 'Try again' });
    retry.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('textbox', { name: /^Contact name/u })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('contact-edit-results')),
    );
  });

  test('maps the complete typed query failure union without exposing raw errors', () => {
    expect(
      classifyContactEditDetailError({ _tag: 'ContactDetailInvalidProblem' } as never),
    ).toEqual({
      state: 'not_found',
    });
    expect(classifyContactEditDetailError({ _tag: 'GatewayForbiddenProblem' } as never)).toEqual({
      state: 'forbidden',
    });
    expect(
      classifyContactEditDetailError({ _tag: 'GatewayAuthenticationRequiredProblem' } as never),
    ).toEqual({ state: 'authentication_expired' });
    expect(classifyContactEditDetailError({ _tag: 'SchemaError' } as never)).toEqual({
      reason: 'decode',
      state: 'unavailable',
    });
    expect(
      classifyContactEditDetailError({
        _tag: 'HttpClientError',
        reason: { _tag: 'TransportError' },
      } as never),
    ).toEqual({ reason: 'transport', state: 'unavailable' });
    for (const tag of [
      'ContactDetailUnavailableProblem',
      'GatewayRateLimitedProblem',
      'GatewayUnavailableProblem',
    ] as const) {
      expect(classifyContactEditDetailError({ _tag: tag } as never)).toEqual({
        reason: 'backend',
        state: 'unavailable',
      });
    }
    for (const tag of [
      'ContactDetailInternalProblem',
      'GatewayAudienceInvalidProblem',
      'GatewayInternalProblem',
    ] as const) {
      expect(classifyContactEditDetailError({ _tag: tag } as never)).toEqual({
        reason: 'internal',
        state: 'unavailable',
      });
    }
  });
});

describe('ContactEdit presentation and mutation', () => {
  test('keeps loaded values visible but disables every mutation control when read-only', async () => {
    renderFeature({ writable: false });

    expect(
      await screen.findByText(
        'CRM is currently read-only. You can review this Contact, but cannot save changes.',
      ),
    ).toBeTruthy();
    for (const name of [/^Contact name/u, /^Email/u, /^Phone/u]) {
      expect(screen.getByRole('textbox', { name }).hasAttribute('disabled')).toBe(true);
    }
    expect(screen.getByRole('button', { name: 'Save Contact' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(editContactMock).not.toHaveBeenCalled();
  });

  test('Back and Cancel preserve locale and hierarchy without invoking the mutation', async () => {
    localeState.current = 'cs';
    const user = userEvent.setup();
    renderFeature();
    const destination = `/cs/crm/customers/${customerId}/contacts/${contactId}`;

    const back = await screen.findByRole('link', { name: 'Zpět na kontakt' });
    expect(back.getAttribute('href')).toBe(destination);
    expect(screen.getByRole('heading', { name: 'Upravit kontakt' })).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'Zrušit' }));
    expect(navigateMock).toHaveBeenCalledWith({ to: destination });
    expect(editContactMock).not.toHaveBeenCalled();
    expect(document.querySelector('[role="tablist"]')).toBeNull();
  });

  test('submits normalized values, updates the exact detail cache, announces, and navigates', async () => {
    const queryClient = renderFeature();
    const user = userEvent.setup();
    const name = await screen.findByRole('textbox', { name: /^Contact name/u });
    const email = screen.getByRole('textbox', { name: /^Email/u });
    const phone = screen.getByRole('textbox', { name: /^Phone/u });
    await user.clear(name);
    await user.type(name, '  Grace Hopper  ');
    await user.clear(email);
    await user.type(email, '  Grace@Example.Test  ');
    await user.clear(phone);
    await user.type(phone, '  987654321  ');
    await user.click(screen.getByRole('button', { name: 'Save Contact' }));

    const destination = `/en/crm/customers/${customerId}/contacts/${contactId}`;
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: destination }));
    expect(editContactMock).toHaveBeenCalledWith(
      {
        contactId,
        email: 'Grace@Example.Test',
        name: 'Grace Hopper',
        phone: '98 765 432 1',
      },
      {
        baseUrl: 'http://localhost:4101/crm-api',
        correlationId: expect.any(String),
        idempotencyKey: expect.any(String),
        locale: 'en',
      },
    );
    expect(queryClient.getQueryData(contactEditDetailQueryKey(customerId, contactId))).toEqual(
      updatedContact,
    );
    expect(screen.getByText('Contact changes saved.')).toBeTruthy();
  });

  test('permits one semantic submit while pending', async () => {
    editContactMock.mockReturnValue(Effect.never);
    const user = userEvent.setup();
    renderFeature();
    const submit = await screen.findByRole('button', { name: 'Save Contact' });

    await user.dblClick(submit);

    await waitFor(() => expect(editContactMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Saving Contact…' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  test('reuses an idempotency key only after an uncertain unchanged retry', async () => {
    editContactMock
      .mockReturnValueOnce(
        Effect.fail({ _tag: 'HttpClientError', reason: { _tag: 'TransportError' } } as never),
      )
      .mockReturnValueOnce(Effect.succeed(updatedContact));
    const user = userEvent.setup();
    renderFeature();
    await screen.findByRole('textbox', { name: /^Contact name/u });

    await user.click(screen.getByRole('button', { name: 'Save Contact' }));
    await screen.findByText(/request may have completed/u);
    await user.click(screen.getByRole('button', { name: 'Save Contact' }));
    await waitFor(() => expect(editContactMock).toHaveBeenCalledTimes(2));

    const firstOptions = editContactMock.mock.calls[0]?.[1];
    const secondOptions = editContactMock.mock.calls[1]?.[1];
    expect(secondOptions.idempotencyKey).toBe(firstOptions.idempotencyKey);
    expect(secondOptions.correlationId).not.toBe(firstOptions.correlationId);
  });

  test('creates a new key after the uncertain intent changes', async () => {
    editContactMock.mockReturnValue(Effect.fail({ _tag: 'CrmUnavailableProblem' } as never));
    const user = userEvent.setup();
    renderFeature();
    const name = await screen.findByRole('textbox', { name: /^Contact name/u });
    await user.click(screen.getByRole('button', { name: 'Save Contact' }));
    await screen.findByText(/temporarily unavailable/u);
    await user.type(name, ' changed');
    await user.click(screen.getByRole('button', { name: 'Save Contact' }));
    await waitFor(() => expect(editContactMock).toHaveBeenCalledTimes(2));

    expect(editContactMock.mock.calls[1]?.[1].idempotencyKey).not.toBe(
      editContactMock.mock.calls[0]?.[1].idempotencyKey,
    );
  });

  test('creates a new key after a definite failure with unchanged values', async () => {
    editContactMock.mockReturnValue(Effect.fail({ _tag: 'CrmForbiddenProblem' } as never));
    const user = userEvent.setup();
    renderFeature();
    await screen.findByRole('textbox', { name: /^Contact name/u });
    await user.click(screen.getByRole('button', { name: 'Save Contact' }));
    await screen.findByText('You do not have permission to edit this Contact.');
    await user.click(screen.getByRole('button', { name: 'Save Contact' }));
    await waitFor(() => expect(editContactMock).toHaveBeenCalledTimes(2));

    expect(editContactMock.mock.calls[1]?.[1].idempotencyKey).not.toBe(
      editContactMock.mock.calls[0]?.[1].idempotencyKey,
    );
  });

  test.each([
    ['CrmInvalidRequestProblem', 'The Contact details were rejected.'],
    ['CrmAuthenticationProblem', 'Your session expired before the Contact could be saved.'],
    ['CrmForbiddenProblem', 'You do not have permission to edit this Contact.'],
    ['CrmNotFoundProblem', 'This Contact no longer exists or is not available to you.'],
    ['CrmConflictProblem', 'The Contact changed while you were editing it.'],
    ['CrmInternalProblem', 'The Contact could not be saved safely.'],
  ] as const)('maps %s, retains values, and does not navigate', async (tag, message) => {
    editContactMock.mockReturnValue(Effect.fail({ _tag: tag } as never));
    const user = userEvent.setup();
    renderFeature();
    const name = await screen.findByRole('textbox', { name: /^Contact name/u });
    await user.type(name, ' changed');

    await user.click(screen.getByRole('button', { name: 'Save Contact' }));

    expect(await screen.findByText(new RegExp(message, 'u'))).toBeTruthy();
    expect(name.getAttribute('value')).toContain('changed');
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test.each([
    ['Customer', { ...updatedContact, customerId: otherCustomerId }],
    ['Contact', { ...updatedContact, contactId: otherContactId }],
  ] as const)(
    'rejects a mismatched returned %s identity without cache or navigation',
    async (_identity, result) => {
      editContactMock.mockReturnValue(Effect.succeed(result));
      const queryClient = renderFeature();
      const user = userEvent.setup();
      await screen.findByRole('textbox', { name: /^Contact name/u });
      await user.click(screen.getByRole('button', { name: 'Save Contact' }));

      expect(
        await screen.findByText('The Contact could not be saved safely. Try again.'),
      ).toBeTruthy();
      expect(navigateMock).not.toHaveBeenCalled();
      expect(queryClient.getQueryData(contactEditDetailQueryKey(customerId, contactId))).toEqual(
        activeContact,
      );
    },
  );

  test('maps every mutation failure family to a closed presentation vocabulary', () => {
    expect(classifyEditContactError({ _tag: 'CrmInvalidRequestProblem' } as never)).toEqual({
      state: 'invalid_form',
    });
    expect(classifyEditContactError({ _tag: 'GatewayForbiddenProblem' } as never)).toEqual({
      state: 'forbidden',
    });
    expect(classifyEditContactError({ _tag: 'CrmPreconditionRequiredProblem' } as never)).toEqual({
      state: 'conflict',
    });
    expect(classifyEditContactError({ _tag: 'SchemaError' } as never)).toEqual({
      reason: 'decode',
      state: 'unavailable',
      uncertain: true,
    });
    expect(classifyEditContactError({ _tag: 'GatewayRateLimitedProblem' } as never)).toEqual({
      reason: 'backend',
      state: 'unavailable',
      uncertain: true,
    });
    expect(
      classifyEditContactError({
        _tag: 'HttpClientError',
        reason: { _tag: 'EmptyBodyError' },
      } as never),
    ).toEqual({ reason: 'decode', state: 'unavailable', uncertain: true });
    for (const tag of [
      'CrmInternalProblem',
      'GatewayAudienceInvalidProblem',
      'GatewayInternalProblem',
    ] as const) {
      expect(classifyEditContactError({ _tag: tag } as never)).toEqual({ state: 'unexpected' });
    }
  });
});

describe('ContactEdit generated boundaries and localization', () => {
  test('keeps ContactForm private and crosses only the generated browser-safe CRM seam', () => {
    const pageSource = readFileSync(
      new URL(
        '../../src/routes/[lang]/crm/customers/[id]/contacts/[contactId]/edit/page.tsx',
        import.meta.url,
      ),
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
    expect(pageSource).toContain('getContact(');
    expect(pageSource).toContain('editContact(');
    expect(pageSource).toContain('target={{ writable: false }}');
    expect(pageSource).toContain('crm:min-w-0 crm:w-full');
    expect(pageSource).not.toMatch(
      /\bfetch\s*\(|api\/index|edit-contact\.action|persistence\.service|src\/db|HttpApiEndpoint/u,
    );
    expect(manifest).toContain("contributionKey: 'crm.core.page.contact-edit'");
    expect(manifest).toContain("routePath: '/crm/customers/:id/contacts/:contactId/edit'");
    expect(manifest).not.toContain('crm.core.navigation.contact-edit');
    expect(registration).toMatch(/'page-contact-edit': \(\) =>\s*import\(/u);
    expect(federation).toContain("'./PageContactEdit'");
    expect(manifest).not.toContain('contact-form');
    expect(registration).not.toContain('contact-form');
    expect(formSource).not.toMatch(/crm-client|routeParams|customerId|contactId|target\.writable/u);
  });

  test('keeps English and Czech ContactEdit locale structures in parity', () => {
    expect(flattenKeys(csCatalog.crm.pages.contactEdit)).toEqual(
      flattenKeys(enCatalog.crm.pages.contactEdit),
    );
  });
});
