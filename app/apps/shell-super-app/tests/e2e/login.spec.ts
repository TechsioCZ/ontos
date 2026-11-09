import { createHash } from 'node:crypto';

import { NodeServices } from '@effect/platform-node';
import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Config, Effect, Predicate, Schema } from 'effect';

import { decodeActiveApplicationCompositionSnapshot } from '../../../../scripts/active-application-composition.mts';
import {
  ResolveModuleTargetPayloadSchema,
  ResolvedModuleTargetSchema,
  ShellAuthenticationApi,
  ShellCapabilityUnavailableProblemSchema,
  ShellReloadRequiredProblemSchema,
  ShellTargetForbiddenProblemSchema,
  shellAuthenticationApiContract,
} from '../../shared/api.ts';
import { createAuthenticationFixture } from './auth-fixture.ts';
import type { AuthenticationFixture } from './auth-fixture.ts';

const hydratedLoginForm = (page: Page) => page.locator('form[data-e2e-hydrated-login="true"]');

// SSR already exposes a visible trigger. Zag's menu becomes interactive after its account action item
// reports hydration and the matching content portal has moved to document.body.
const waitForInteractiveAccountMenu = async (page: Page) => {
  await page.waitForFunction(() => {
    const trigger = document.querySelector<HTMLButtonElement>('button[data-scope="menu"][data-part="trigger"]');
    if (trigger === null) {
      return false;
    }
    if (trigger.closest('[data-hydrated]') === null) {
      return false;
    }
    const positioner = document.querySelector('[data-scope="menu"][data-part="positioner"]');
    const content = positioner?.querySelector('[data-scope="menu"][data-part="content"]');
    return (
      positioner?.parentElement === document.body &&
      content?.getAttribute('id') === trigger.getAttribute('aria-controls')
    );
  });
};

const gotoHydratedLogin = async (page: Page, language: 'cs' | 'en') => {
  await page.goto(`/${language}/login`);
  await page.waitForFunction(() => {
    const forms = [...document.querySelectorAll<HTMLFormElement>('form')].filter(
      (form) => form.querySelector('input[name="login"]') !== null,
    );
    let hydratedForm: HTMLFormElement | undefined;
    for (const form of forms) {
      if (Object.hasOwn(form.dataset, 'hydrated')) {
        hydratedForm = form;
      }
    }
    if (hydratedForm === undefined) {
      return false;
    }
    for (const form of forms) {
      delete form.dataset['e2eHydratedLogin'];
    }
    const hydratedSince = Number(hydratedForm.dataset['e2eHydratedSince']);
    if (!Number.isFinite(hydratedSince)) {
      hydratedForm.dataset['e2eHydratedSince'] = String(performance.now());
      return false;
    }
    if (performance.now() - hydratedSince < 1000) {
      return false;
    }
    hydratedForm.dataset['e2eHydratedLogin'] = 'true';
    return true;
  });
};

const login = async (page: Page, language: 'cs' | 'en', credentials: AuthenticationFixture['credentials']) => {
  await gotoHydratedLogin(page, language);
  const form = hydratedLoginForm(page);
  const labels =
    language === 'en'
      ? {
          login: /^Login\s*\*$/u,
          password: /^Password/u,
          submit: 'Login',
          url: /\/en\/?$/u,
        }
      : {
          login: /^Přihlašovací jméno\s*\*$/u,
          password: /^Heslo/u,
          submit: 'Přihlásit se',
          url: /\/cs\/?$/u,
        };
  await form.getByRole('textbox', { name: labels.login }).fill(credentials.email);
  await form.getByLabel(labels.password).fill(credentials.password);
  await form.getByRole('button', { name: labels.submit }).click();
  await expect(page).toHaveURL(labels.url);
};

const sessionPath = `${shellAuthenticationApiContract.apiPrefix}/auth/session`;

// The dashboard no longer prints e-mail or internal identifiers. Existing test
// callbacks check the cookie-backed public session endpoint against this value.
const expectedAuthenticatedSession = (
  authentication: AuthenticationFixture,
  tenant: AuthenticationFixture['tenants']['first'],
) => ({
  identity: {
    email: authentication.credentials.email,
    legalEntityId: tenant.legalEntityId,
    principalId: tenant.principalId,
    tenantId: tenant.tenantId,
  },
  state: 'authenticated',
});

// Only this real Playwright worker fixture runs Effect. Each worker owns its
// identities; Playwright still gives every test an independent browser context.
//
// Playwright's setup timeout abandons the callback before `use` and skips its teardown.
// Let Effect own the acquisition deadline and finish scoped cleanup instead; test-body
// timeouts stay enabled. Foreign operations retain their real server deadlines.
const workerFixtureAcquisitionTimeout = '25 seconds';

const test = base.extend<Record<never, never>, { authentication: AuthenticationFixture }>({
  authentication: [
    async ({ browserName: _browserName }, use) => {
      await Effect.runPromise(
        Effect.gen(function* useAuthenticationFixture() {
          const fixture = yield* Effect.timeout(createAuthenticationFixture(), workerFixtureAcquisitionTimeout);
          yield* Effect.tryPromise(async () => await use(fixture));
        }).pipe(Effect.scoped),
      );
    },
    { scope: 'worker', timeout: 0 },
  ],
});

test('preserves a validated return destination query and fragment after sign-in', async ({ authentication, page }) => {
  const returnTo = encodeURIComponent('/cs/profile?q=100%25#matched');
  await page.goto(`/cs/login?returnTo=${returnTo}`);
  const form = page.locator('form[data-hydrated="true"]');
  await form.locator('input[name="login"]').fill(authentication.credentials.email);
  await form.locator('input[name="password"]').fill(authentication.credentials.password);
  await form.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(
    (url) => url.pathname === '/cs/profile' && url.searchParams.get('q') === '100%' && url.hash === '#matched',
  );
});

test('redirects anonymous English and Czech home requests to localized login without dashboard chrome', async ({
  page,
}) => {
  const expectAnonymousHome = async (language: string, heading: string, submit: string) => {
    await page.goto(`/${language}/`);
    await expect(page).toHaveURL(new RegExp(`/${language}/login/?(?:\\?.*)?$`, 'u'));
    await Promise.all([
      expect(page.getByRole('heading', { exact: true, name: heading })).toBeVisible(),
      expect(page.getByRole('button', { exact: true, name: submit })).toBeVisible(),
      expect(page.locator('input[name="login"]')).toBeVisible(),
      expect(page.locator('input[name="password"]')).toBeVisible(),
      expect(page.getByRole('checkbox')).toHaveCount(0),
      expect(page.locator('header[aria-label]')).toHaveCount(0),
      expect(page.getByRole('complementary')).toHaveCount(0),
      expect(page.locator('button[aria-haspopup="menu"]')).toHaveCount(0),
    ]);
  };
  await expectAnonymousHome('en', 'Login', 'Login');
  await expectAnonymousHome('cs', 'Přihlášení', 'Přihlásit se');
});

test('keeps English and Czech login pages free of authenticated dashboard chrome', async ({ page }) => {
  const expectDashboardAbsent = async () =>
    await Promise.all([
      expect(page.locator('header[aria-label]')).toHaveCount(0),
      expect(page.getByRole('complementary')).toHaveCount(0),
      expect(page.locator('button[aria-haspopup="menu"]')).toHaveCount(0),
    ]);

  await gotoHydratedLogin(page, 'en');
  await expectDashboardAbsent();
  await gotoHydratedLogin(page, 'cs');
  await expectDashboardAbsent();
});

test('shows one generic error for invalid English credentials', async ({ authentication, page }) =>
  await gotoHydratedLogin(page, 'en')
    .then(
      async () =>
        await hydratedLoginForm(page)
          .getByRole('textbox', { name: /^Login\s*\*$/u })
          .fill(authentication.credentials.email),
    )
    .then(
      async () =>
        await hydratedLoginForm(page)
          .getByLabel(/^Password/u)
          .fill('wrong-password'),
    )
    .then(async () => await hydratedLoginForm(page).getByRole('button', { name: 'Login' }).click())
    .then(
      async () =>
        await Promise.all([
          expect(page.getByText('The login or password is invalid.')).toHaveCount(1),
          expect(hydratedLoginForm(page).getByRole('textbox', { name: /^Login\s*\*$/u })).toHaveValue(
            authentication.credentials.email,
          ),
          expect(hydratedLoginForm(page).getByLabel(/^Password/u)).toBeFocused(),
        ]),
    ));

test('logs a user in without any server-error response', async ({ authentication, page }, testInfo) => {
  const { baseURL } = testInfo.project.use;
  if (!Predicate.isString(baseURL)) {
    throw new TypeError('The login E2E test requires a configured base URL');
  }

  const applicationOrigin = new URL(baseURL).origin;
  const serverErrors: string[] = [];

  page.on('response', (response) => {
    const responseURL = new URL(response.url());
    if (responseURL.origin === applicationOrigin && response.status() >= 500 && response.status() < 600) {
      serverErrors.push(
        `${response.request().method()} ${responseURL.pathname}${responseURL.search} returned ${response.status()}`,
      );
    }
  });

  await gotoHydratedLogin(page, 'en');
  const form = hydratedLoginForm(page);
  await form.getByRole('textbox', { name: /^Login\s*\*$/u }).fill(authentication.credentials.email);
  await form.getByLabel(/^Password/u).fill(authentication.credentials.password);

  const signInResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === shellAuthenticationApiContract.signInPath &&
      response.request().method() === 'POST',
  );
  await form.getByRole('button', { name: 'Login' }).click();
  const signInResponse = await signInResponsePromise;

  expect(signInResponse.status(), 'The sign-in endpoint should accept valid credentials').toBe(200);
  await expect(page).toHaveURL(/\/en\/?$/u);
  await expect(page.getByRole('button', { name: 'E2E user' })).toBeVisible();
  const sessionResponse = await page.request.get(sessionPath);
  expect(sessionResponse.status()).toBe(200);
  expect(await sessionResponse.json()).toMatchObject(
    expectedAuthenticatedSession(authentication, authentication.tenants.first),
  );
  await expect(page.getByRole('complementary', { name: 'Dashboard sidebar' })).toBeVisible();
  await expect(page.locator('header[aria-label="Dashboard header"]')).toBeVisible();
  expect(serverErrors, 'Login and the authenticated page must not return HTTP 5xx').toEqual([]);
});

test('loads localized English and Czech Contacts pages only after login', async ({ authentication, page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/en/contacts');
  await expect(page).toHaveURL(/\/en\/login(?:\?.*)?$/u);
  await expect(page.getByRole('heading', { name: 'Contacts' })).toHaveCount(0);
  await page.goto('/cs/contacts');
  await expect(page).toHaveURL(/\/cs\/login(?:\?.*)?$/u);
  await expect(page.getByRole('heading', { name: 'Kontakty' })).toHaveCount(0);

  await login(page, 'cs', authentication.credentials);
  // Party Registry contributes Customers and the protected Contacts destination to navigation.
  const dashboardNavigation = page.getByRole('navigation', { name: 'Navigace přehledu' });
  const customersLink = dashboardNavigation.getByRole('link', { name: 'Zákazníci' });
  await expect(customersLink).toBeVisible();
  await expect(
    dashboardNavigation
      .getByRole('listitem')
      .filter({ hasText: 'Nasazení modulu je dočasně nedostupné.' })
      .filter({ hasText: 'party-registry' }),
  ).toHaveCount(0);

  await expect(customersLink).toHaveAttribute('href', '/cs/prodej/zakaznici');
  await page.goto('/cs/contacts');

  const expectContacts = async (content: {
    description: string;
    empty: string;
    heading: string;
    module: string;
    placeholder: string;
    url: RegExp;
  }) => {
    await expect(page).toHaveURL(content.url);
    await expect(page.getByRole('heading', { name: content.heading })).toBeVisible();
    await expect(page.getByRole('heading', { exact: true, name: content.module })).toHaveCount(0);
    await expect(page.getByText(content.description)).toBeVisible();
    await expect(page.getByText(content.placeholder)).toHaveCount(0);
    await expect(page.getByText(content.empty)).toHaveCount(0);
  };
  await expectContacts({
    description: 'Kanonické strany, protistrany a jejich profily zapojení v jednom modulu.',
    empty: 'Zatím zde není žádný obsah.',
    heading: 'Kontakty',
    module: 'Modul',
    placeholder: 'Tato stránka je připravena k implementaci.',
    url: /\/cs\/contacts\/?$/u,
  });
  await expect(page.getByRole('complementary', { name: 'Postranní panel přehledu' })).toBeVisible();

  await page.goto('/en/contacts');
  await expectContacts({
    description: 'Party Registry keeps canonical Parties, Counterparties, and their engagement profiles in one module.',
    empty: 'No content has been added yet.',
    heading: 'Contacts',
    module: 'Module',
    placeholder: 'This page is ready for implementation.',
    url: /\/en\/contacts\/?$/u,
  });
  await expect(page.getByText('The module is temporarily unavailable. Try again.')).toHaveCount(0);
  const dashboardSidebar = page.getByRole('complementary', {
    name: 'Dashboard sidebar',
  });
  await expect(dashboardSidebar).toBeVisible();
  const [sidebarBox, mainBox] = await Promise.all([dashboardSidebar.boundingBox(), page.locator('main').boundingBox()]);
  expect(sidebarBox?.width).toBe(256);
  expect(mainBox?.x).toBe(256);
  expect(
    pageErrors.filter((message) => message.includes('FederatedI18nBoundary must be used within ModernI18nProvider')),
  ).toEqual([]);
});

test('keeps authenticated Shell chrome on search and guarded direct-target routes', async ({
  authentication,
  page,
}) => {
  await login(page, 'en', authentication.credentials);

  // The top-bar search is controlled: typed text reaches the query only through the renderer's change event.
  await waitForInteractiveAccountMenu(page);
  const header = page.locator('header[aria-label="Dashboard header"]');
  const searchbox = header.getByRole('searchbox', { exact: true, name: 'Search' });
  await searchbox.fill('Unit 1');
  await searchbox.press('Enter');
  await expect(page).toHaveURL(/\/en\/search\?q=Unit%201$/u);
  await expect(page.getByText('Nothing found for “Unit 1”.', { exact: true })).toBeVisible();

  const expectPersistentShell = async (path: string, status: string) => {
    await page.goto(path);
    await expect(page.getByRole('complementary', { name: 'Dashboard sidebar' })).toBeVisible();
    await expect(page.locator('header[aria-label="Dashboard header"]')).toBeVisible();
    await expect(page.getByText(status)).toBeVisible();
  };
  await expectPersistentShell('/en/search', 'Search clients, tasks, invoices, contracts…');
  await expect(page.getByText('No authorized results found.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Nothing found for “Unit 1”.', { exact: true })).toHaveCount(0);
  await expectPersistentShell('/en/modules/not-installed', 'This module is not available in the current context.');
  await expectPersistentShell(
    '/en/resources/not-installed/example/missing',
    'This resource was not found in the current context.',
  );
});

const contactsRenderInitializationFault = 'ontos-e2e-contacts-render-initialization-fault';
const contactsSectionSelector = 'section[aria-labelledby="contacts-heading"]';
const compositionRevisionSelector = 'meta[name="ontos-composition-revision"]';
const moduleTargetPath = `${shellAuthenticationApiContract.apiPrefix}${ShellAuthenticationApi.groups.composition.endpoints.resolveModuleTarget.path}`;

// Redact initializes a newly created detached host inside its guarded renderNode call:
// renderHost -> applyHostProps -> setAttribute. This exact Contacts attribute injects a
// RENDER-PHASE HOST INITIALIZATION failure without rewriting approved remote bytes/exports.
// Unit tests separately cover component-function throws. Raw DOM commits, async errors,
// CPU stalls and tab crashes are outside this browser assertion's protection claim.
const installContactsRenderInitializationFault = (page: Page) =>
  page.evaluateHandle((marker) => {
    const setAttributeDescriptor: TypedPropertyDescriptor<Element['setAttribute']> | undefined =
      Object.getOwnPropertyDescriptor(Element.prototype, 'setAttribute');
    const originalSetAttribute = setAttributeDescriptor?.value;
    if (setAttributeDescriptor === undefined || originalSetAttribute === undefined) {
      throw new Error('Native DOM setAttribute descriptor is unavailable');
    }
    let fired = false;
    const restore = () => {
      Object.defineProperty(Element.prototype, 'setAttribute', setAttributeDescriptor);
    };
    Element.prototype.setAttribute = function setAttribute(this: Element, name: string, value: string): void {
      originalSetAttribute.call(this, name, value);
      if (
        !fired &&
        !this.isConnected &&
        this.localName === 'section' &&
        name === 'aria-labelledby' &&
        value === 'contacts-heading'
      ) {
        fired = true;
        restore();
        document.documentElement.dataset['e2eContactsRenderInitializationFault'] = 'fired';
        throw new Error(marker);
      }
    };
    return restore;
  }, contactsRenderInitializationFault);

test('contains a Contacts render-phase failure and rechecks revoked access across real document reloads', async ({
  authentication,
  page,
}) => {
  await login(page, 'en', authentication.credentials);
  const revision = await page.locator(compositionRevisionSelector).getAttribute('content');
  const payload = Schema.decodeUnknownSync(ResolveModuleTargetPayloadSchema)({
    canonicalPath: '/contacts',
    compositionRevision: revision,
  });
  const requestOptions = { data: payload, headers: { origin: new URL(page.url()).origin } };
  const approvedResponse = await page.request.post(moduleTargetPath, requestOptions);
  expect(approvedResponse.status()).toBe(200);
  const approved = Schema.decodeUnknownSync(ResolvedModuleTargetSchema)(await approvedResponse.json());
  expect(approved.appId).toBe('party-registry');
  expect(approved.componentKey).toBe('party.registry.page-contacts');
  expect(approved.federation.expose).toBe('./PageContacts');
  const expectApprovedManifestBytes = async () => {
    const manifest = await page.request.get(approved.federation.manifest.url);
    expect(manifest.status()).toBe(200);
    expect(
      createHash('sha256')
        .update(await manifest.body())
        .digest('hex'),
    ).toBe(approved.federation.manifest.sha256);
  };
  await expectApprovedManifestBytes();
  const navigation = page.getByRole('navigation', { name: 'Dashboard navigation' });
  const sidebar = page.getByRole('complementary', { name: 'Dashboard sidebar' });
  await expect(navigation.getByRole('link', { exact: true, name: 'Contacts' })).toBeVisible();
  const restoreFault = await installContactsRenderInitializationFault(page);
  try {
    await navigation.getByRole('link', { exact: true, name: 'Contacts' }).click();
    const localFailure = page.getByRole('alert');
    await expect(localFailure).toHaveText('This module could not be displayed. Reload the page to try again.');
    await expect(localFailure).not.toContainText(contactsRenderInitializationFault);
    await expect(page.locator('html')).toHaveAttribute('data-e2e-contacts-render-initialization-fault', 'fired');
    await expect(page.locator(contactsSectionSelector)).toHaveCount(0);
    await expect(page.getByRole('button', { exact: true, name: 'Reload page' })).toBeEnabled();
    await expect(page.locator('header[aria-label="Dashboard header"]')).toBeVisible();
    await expect(sidebar).toBeVisible();
    await sidebar.getByRole('searchbox', { exact: true, name: 'Search' }).fill('still usable');
    await expect(sidebar.getByRole('searchbox', { exact: true, name: 'Search' })).toHaveValue('still usable');
    await sidebar.getByRole('searchbox', { exact: true, name: 'Search' }).clear();
    await waitForInteractiveAccountMenu(page);
  } finally {
    await restoreFault.evaluate((restore) => restore());
    await restoreFault.dispose();
  }
  // This is same-Composition browser evidence. A genuine R1 -> R2 browser publication
  // remains the separately isolated #1297 joint acceptance; observation renewal is not R2.
  await Effect.runPromise(
    Effect.gen(function* useScopedContactsRevocation() {
      yield* authentication.acquireFirstTenantContactsAccessRevocation();
      yield* Effect.tryPromise(async () => {
        await page.evaluate(() => {
          document.documentElement.dataset['e2eRenderRecoveryDocument'] = 'failed-first-tenant';
        });
        const firstDocumentTimeOrigin = await page.evaluate(() => performance.timeOrigin);
        await Promise.all([
          page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
          page.getByRole('button', { exact: true, name: 'Reload page' }).click(),
        ]);
        await expect(page.getByText('You do not have permission to open this module.', { exact: true })).toBeVisible();
        await expect(page.locator('html')).not.toHaveAttribute('data-e2e-render-recovery-document');
        expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(firstDocumentTimeOrigin);
        await expect(page.locator(compositionRevisionSelector)).toHaveAttribute(
          'content',
          approved.compositionRevision,
        );
        await expect(page.locator(contactsSectionSelector)).toHaveCount(0);
        await expect(page.getByRole('alert')).toHaveCount(0);
        const deniedResponse = await page.request.post(moduleTargetPath, requestOptions);
        expect(deniedResponse.status()).toBe(403);
        const deniedBody = await deniedResponse.json();
        Schema.decodeUnknownSync(ShellTargetForbiddenProblemSchema)(deniedBody);
        expect(deniedBody).not.toHaveProperty('federation');
        await expect(page.locator('header[aria-label="Dashboard header"]')).toBeVisible();
        await expect(sidebar).toBeVisible();
        const tenant = page.getByRole('combobox', { name: 'Current tenant' });
        await expect(tenant).toContainText(authentication.tenants.first.name);
        await tenant.click();
        await page.evaluate(() => {
          document.documentElement.dataset['e2eRenderRecoveryDocument'] = 'denied-first-tenant';
        });
        const deniedDocumentTimeOrigin = await page.evaluate(() => performance.timeOrigin);
        const switchedResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === shellAuthenticationApiContract.switchTenantPath &&
            response.request().method() === 'POST',
        );
        await Promise.all([
          page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
          page.getByRole('option', { name: authentication.tenants.second.name }).click(),
        ]);
        const switchResult = await switchedResponse;
        expect(switchResult.status()).toBe(200);
        await expect(tenant).toContainText(authentication.tenants.second.name);
        await expect(page.locator('html')).not.toHaveAttribute('data-e2e-render-recovery-document');
        expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(deniedDocumentTimeOrigin);
        await expect(page.getByRole('button', { name: 'E2E user second tenant' })).toBeVisible();
        await expect(page.locator(compositionRevisionSelector)).toHaveAttribute(
          'content',
          approved.compositionRevision,
        );
        await expect(page.locator(contactsSectionSelector)).toBeVisible();
        await expect(page.getByRole('heading', { exact: true, name: 'Contacts' })).toBeVisible();
        await expect(page.getByRole('alert')).toHaveCount(0);
        await expect(page.locator('header[aria-label="Dashboard header"]')).toBeVisible();
        await expect(sidebar).toBeVisible();
        const secondTargetResponse = await page.request.post(moduleTargetPath, requestOptions);
        expect(secondTargetResponse.status()).toBe(200);
        const secondTarget = Schema.decodeUnknownSync(ResolvedModuleTargetSchema)(await secondTargetResponse.json());
        expect(secondTarget.federation).toEqual(approved.federation);
        await expectApprovedManifestBytes();
        // The independent Tenant/Principal retains its own grant while the first remains revoked.
        await navigation.getByRole('link', { exact: true, name: 'Home' }).click();
        await expect(page).toHaveURL(/\/en\/?$/u);
        await expect(page.getByRole('button', { name: 'E2E user second tenant' })).toBeVisible();
      });
    }).pipe(Effect.scoped),
  );
});

const CompositionFixtureMetadataSchema = Schema.Struct({ activeApplicationCompositionUrl: Schema.URLFromString });
const RetainedPartyPromotionSchema = Schema.Struct({
  compositionRevision: ResolvedModuleTargetSchema.fields.compositionRevision,
  previousRevision: ResolvedModuleTargetSchema.fields.compositionRevision,
});

test('reloads failed Contacts into a genuinely published R2 with exact retained artifacts', async ({
  authentication,
  page,
}, testInfo) => {
  const promotionEnabled = await Effect.runPromise(
    Effect.gen(function* readExclusiveR2BrowserFlag() {
      return yield* Config.Boolean('ONTOS_E2E_RETAINED_PARTY_R2').pipe(Config.withDefault(false));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  test.skip(!promotionEnabled, 'Requires the exclusive isolated R2 browser driver');
  expect(testInfo.config.workers).toBe(1);
  test.setTimeout(90_000);
  await login(page, 'en', authentication.credentials);
  const { activeApplicationCompositionUrl } = Schema.decodeUnknownSync(CompositionFixtureMetadataSchema)(
    testInfo.config.metadata,
  );
  const observePublishedSnapshot = async () => {
    const response = await page.request.get(activeApplicationCompositionUrl.href);
    expect(response.status()).toBe(200);
    return await Effect.runPromise(decodeActiveApplicationCompositionSnapshot(await response.text()));
  };
  const originalSnapshot = await observePublishedSnapshot();
  const originalRevision = originalSnapshot.composition.revision;
  await expect(page.locator(compositionRevisionSelector)).toHaveAttribute('content', originalRevision);
  expect(originalSnapshot.composition.modules.map(({ deployment }) => deployment.appId).toSorted()).toEqual([
    'inventory',
    'party-registry',
  ]);
  const { origin } = new URL(page.url());
  const originalPayload = Schema.decodeUnknownSync(ResolveModuleTargetPayloadSchema)({
    canonicalPath: '/contacts',
    compositionRevision: originalRevision,
  });
  const originalResponse = await page.request.post(moduleTargetPath, { data: originalPayload, headers: { origin } });
  expect(originalResponse.status()).toBe(200);
  const originalTarget = Schema.decodeUnknownSync(ResolvedModuleTargetSchema)(await originalResponse.json());
  expect(originalTarget.componentKey).toBe('party.registry.page-contacts');
  expect(originalTarget.federation.expose).toBe('./PageContacts');
  const originalPartyPins = originalSnapshot.composition.modules.filter(
    ({ deployment }) => deployment.appId === 'party-registry',
  );
  expect(originalPartyPins).toHaveLength(1);
  const navigation = page.getByRole('navigation', { name: 'Dashboard navigation' });
  const restoreFault = await installContactsRenderInitializationFault(page);
  try {
    await navigation.getByRole('link', { exact: true, name: 'Contacts' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'This module could not be displayed. Reload the page to try again.',
    );
    await expect(page.getByRole('alert')).not.toContainText(contactsRenderInitializationFault);
    await expect(page.locator('html')).toHaveAttribute('data-e2e-contacts-render-initialization-fault', 'fired');
    await expect(page.locator(contactsSectionSelector)).toHaveCount(0);
    await expect(page.locator('header[aria-label="Dashboard header"]')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Dashboard sidebar' })).toBeVisible();
    await waitForInteractiveAccountMenu(page);
  } finally {
    await restoreFault.evaluate((restore) => restore());
    await restoreFault.dispose();
  }
  // This fixed test control uses real Core publication authority and current executable
  // artifacts. It is not staging-wrapper evidence or permission to replace a live document.
  const promotionResponse = await page.request.post(
    new URL('/promote-retained-party', activeApplicationCompositionUrl).href,
    {
      headers: { origin },
    },
  );
  expect(promotionResponse.status()).toBe(200);
  const promotion = Schema.decodeUnknownSync(RetainedPartyPromotionSchema)(await promotionResponse.json());
  expect(promotion.previousRevision).toBe(originalRevision);
  expect(promotion.compositionRevision).not.toBe(originalRevision);
  const promotedSnapshot = await observePublishedSnapshot();
  expect(promotedSnapshot.composition.revision).toBe(promotion.compositionRevision);
  expect(promotedSnapshot.composition.modules.map(({ deployment }) => deployment.appId)).toEqual(['party-registry']);
  expect(promotedSnapshot.composition.modules).toEqual(originalPartyPins);
  expect(promotedSnapshot.composition.shell).toEqual(originalSnapshot.composition.shell);
  const promotedPayload = Schema.decodeUnknownSync(ResolveModuleTargetPayloadSchema)({
    canonicalPath: '/contacts',
    compositionRevision: promotion.compositionRevision,
  });
  const admissionStatuses: number[] = [];
  // The native source may hold a successful R1 read for 30s; allow its bounded
  // fetch/validation latency as well, without a fixed sleep or cache bypass.
  await expect
    .poll(
      async () => {
        const response = await page.request.post(moduleTargetPath, { data: promotedPayload, headers: { origin } });
        admissionStatuses.push(response.status());
        if (response.status() !== 200) {
          Schema.decodeUnknownSync(
            Schema.Union([ShellReloadRequiredProblemSchema, ShellCapabilityUnavailableProblemSchema]),
          )(await response.json());
          return null;
        }
        const target = Schema.decodeUnknownSync(ResolvedModuleTargetSchema)(await response.json());
        expect(target.federation).toEqual(originalTarget.federation);
        expect(target.componentKey).toBe(originalTarget.componentKey);
        expect(target.entrypointKey).toBe(originalTarget.entrypointKey);
        return target.compositionRevision;
      },
      { intervals: [250, 1000, 2500], timeout: 45_000 },
    )
    .toBe(promotion.compositionRevision);
  expect(admissionStatuses.every((status) => status === 200 || status === 409 || status === 503)).toBe(true);
  // Admission was observed through HTTP only. The failed original document remains R1;
  // no R2 component is inserted into it and no SDK identity is forced or relabeled.
  await expect(page.locator(compositionRevisionSelector)).toHaveAttribute('content', originalRevision);
  await expect(page.getByRole('alert')).toHaveText('This module could not be displayed. Reload the page to try again.');
  await expect(page.locator(contactsSectionSelector)).toHaveCount(0);
  const obsoleteTargetResponse = await page.request.post(moduleTargetPath, {
    data: originalPayload,
    headers: { origin },
  });
  expect(obsoleteTargetResponse.status()).toBe(409);
  Schema.decodeUnknownSync(ShellReloadRequiredProblemSchema)(await obsoleteTargetResponse.json());
  await page.evaluate(() => {
    document.documentElement.dataset['e2eRetainedPartyR2Document'] = 'failed-r1';
  });
  const originalDocumentTimeOrigin = await page.evaluate(() => performance.timeOrigin);
  await Promise.all([
    page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
    page.getByRole('button', { exact: true, name: 'Reload page' }).click(),
  ]);
  await expect(page.locator('html')).not.toHaveAttribute('data-e2e-retained-party-r2-document');
  expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(originalDocumentTimeOrigin);
  await expect(page.locator(compositionRevisionSelector)).toHaveAttribute('content', promotion.compositionRevision);
  await expect(page.locator(contactsSectionSelector)).toBeVisible();
  await expect(page.getByRole('heading', { exact: true, name: 'Contacts' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('header[aria-label="Dashboard header"]')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Dashboard sidebar' })).toBeVisible();
  const freshTargetResponse = await page.request.post(moduleTargetPath, {
    data: promotedPayload,
    headers: { origin },
  });
  expect(freshTargetResponse.status()).toBe(200);
  const freshTarget = Schema.decodeUnknownSync(ResolvedModuleTargetSchema)(await freshTargetResponse.json());
  expect(freshTarget.compositionRevision).toBe(promotion.compositionRevision);
  expect(freshTarget.federation).toEqual(originalTarget.federation);
  expect(freshTarget.componentKey).toBe(originalTarget.componentKey);
  const manifestResponse = await page.request.get(freshTarget.federation.manifest.url);
  expect(manifestResponse.status()).toBe(200);
  expect(
    createHash('sha256')
      .update(await manifestResponse.body())
      .digest('hex'),
  ).toBe(originalTarget.federation.manifest.sha256);
  await testInfo.attach('retained-party-r2-browser.json', {
    body: JSON.stringify(
      {
        actualNewDocument: true,
        admissionStatuses,
        compositionRevision: promotion.compositionRevision,
        evidence: 'Local real Core publication and current executable browser artifacts; no staging-wrapper claim',
        previousRevision: originalRevision,
        retainedPartyPins: originalPartyPins,
        shellPins: promotedSnapshot.composition.shell,
      },
      undefined,
      2,
    ),
    contentType: 'application/json',
  });
});

test('persists an English session, logs out, clears the cookie, and stays anonymous', async ({
  authentication,
  page,
}) =>
  await gotoHydratedLogin(page, 'en')
    .then(
      async () =>
        await hydratedLoginForm(page)
          .getByRole('textbox', { name: /^Login\s*\*$/u })
          .fill(authentication.credentials.email),
    )
    .then(
      async () =>
        await hydratedLoginForm(page)
          .getByLabel(/^Password/u)
          .fill(authentication.credentials.password),
    )
    .then(async () => await hydratedLoginForm(page).getByRole('button', { name: 'Login' }).click())
    .then(async () => await expect(page).toHaveURL(/\/en\/?$/u))
    .then(async () => {
      const sessionResponse = await page.request.get(sessionPath);
      expect(sessionResponse.status()).toBe(200);
      expect(await sessionResponse.json()).toMatchObject(
        expectedAuthenticatedSession(authentication, authentication.tenants.first),
      );
      await Promise.all([
        expect(page.getByRole('button', { name: 'E2E user' })).toBeVisible(),
        expect(page.getByRole('link', { name: 'Home' })).toHaveCount(1),
      ]);
    })
    .then(async () => await page.reload())
    .then(async () => await waitForInteractiveAccountMenu(page))
    .then(async () => await expect(page.getByRole('button', { name: 'E2E user' })).toBeVisible())
    .then(async () => await page.getByRole('button', { name: 'E2E user' }).click())
    .then(async () => await page.getByRole('menuitem', { name: 'Logout' }).click())
    .then(async () => await expect(page).toHaveURL(/\/en\/login\/?$/u))
    .then(
      async () =>
        await Promise.all([
          expect(page.getByRole('heading', { name: 'Login' })).toBeVisible(),
          expect(page.getByRole('button', { name: 'Login' })).toBeVisible(),
          expect(page.locator('header[aria-label]')).toHaveCount(0),
          expect(page.getByRole('complementary')).toHaveCount(0),
        ]),
    )
    .then(async () => await page.reload())
    .then(async () => {
      await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();
      const response = await page.request.get(sessionPath);
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ state: 'anonymous' });
      await page.goto('/en/');
      await expect(page).toHaveURL(/\/en\/login(?:\?.*)?$/u);
      await expect(page.getByRole('button', { name: 'E2E user' })).toHaveCount(0);
    }));

test('ends the Home another tab of the same browser shows when the account signs out', async ({
  authentication,
  context,
  page,
}) => {
  await login(page, 'en', authentication.credentials);
  const otherTab = await context.newPage();
  await otherTab.goto('/en/');
  await expect(otherTab.getByRole('button', { name: 'E2E user' })).toBeVisible();

  await waitForInteractiveAccountMenu(page);
  await page.getByRole('button', { name: 'E2E user' }).click();
  await page.getByRole('menuitem', { name: 'Logout' }).click();
  await expect(page).toHaveURL(/\/en\/login\/?$/u);

  // The open tab reloads to the sign-in page: it never keeps showing the account that just signed out.
  await expect(otherTab).toHaveURL(/\/en\/login(?:\?.*)?$/u);
  await expect(otherTab.getByRole('button', { name: 'E2E user' })).toHaveCount(0);
  await otherTab.close();
});

test('switches tenant by pointer, fully reloads, and persists the selected context', async ({
  authentication,
  page,
}) => {
  await login(page, 'en', authentication.credentials);

  const tenant = page.getByRole('combobox', { name: 'Current tenant' });
  await expect(tenant).toContainText(authentication.tenants.first.name);
  const firstSessionResponse = await page.request.get(sessionPath);
  expect(firstSessionResponse.status()).toBe(200);
  expect(await firstSessionResponse.json()).toMatchObject(
    expectedAuthenticatedSession(authentication, authentication.tenants.first),
  );
  await tenant.click();
  const switchResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === shellAuthenticationApiContract.switchTenantPath &&
      response.request().method() === 'POST',
  );
  await Promise.all([
    page.waitForEvent('framenavigated', {
      predicate: (frame) => frame === page.mainFrame(),
    }),
    page.getByRole('option', { name: authentication.tenants.second.name }).click(),
  ]);
  const switchResponse = await switchResponsePromise;
  expect(switchResponse.status()).toBe(200);
  await expect(page.getByRole('combobox', { name: 'Current tenant' })).toContainText(
    authentication.tenants.second.name,
  );
  await expect(page.getByRole('button', { name: 'E2E user second tenant' })).toBeVisible();
  const secondSessionResponse = await page.request.get(sessionPath);
  expect(secondSessionResponse.status()).toBe(200);
  expect(await secondSessionResponse.json()).toMatchObject(
    expectedAuthenticatedSession(authentication, authentication.tenants.second),
  );

  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Current tenant' })).toContainText(
    authentication.tenants.second.name,
  );
  await expect(page.getByRole('button', { name: 'E2E user second tenant' })).toBeVisible();
  const reloadedSessionResponse = await page.request.get(sessionPath);
  expect(reloadedSessionResponse.status()).toBe(200);
  expect(await reloadedSessionResponse.json()).toMatchObject(
    expectedAuthenticatedSession(authentication, authentication.tenants.second),
  );
});

test('retains Czech tenant context after one failed switch and supports keyboard retry', async ({
  authentication,
  page,
}) => {
  let failSwitch = true;
  await login(page, 'cs', authentication.credentials);
  await page.route(`**${shellAuthenticationApiContract.switchTenantPath}`, async (route) => {
    if (failSwitch) {
      failSwitch = false;
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  const tenant = page.getByRole('combobox', { name: 'Organizace' });
  await expect(tenant).toContainText(authentication.tenants.first.name);
  await tenant.click();
  await page.getByRole('option', { name: authentication.tenants.second.name }).click();
  await expect(page.getByText('Přepnutí tenantu selhalo. Zkuste to znovu.')).toBeVisible();
  await expect(tenant).toContainText(authentication.tenants.first.name);
  const retainedSessionResponse = await page.request.get(sessionPath);
  expect(retainedSessionResponse.status()).toBe(200);
  expect(await retainedSessionResponse.json()).toMatchObject(
    expectedAuthenticatedSession(authentication, authentication.tenants.first),
  );

  await tenant.focus();
  await page.keyboard.press('Enter');
  const secondTenantOption = page.getByRole('option', {
    name: authentication.tenants.second.name,
  });
  await expect(secondTenantOption).toBeVisible();
  const tenantListbox = page.getByRole('listbox');
  await tenantListbox.press('End');
  const secondTenantOptionId = await secondTenantOption.getAttribute('id');
  expect(secondTenantOptionId).not.toBeNull();
  await expect(tenantListbox).toHaveAttribute('aria-activedescendant', secondTenantOptionId ?? '');
  await Promise.all([
    page.waitForEvent('framenavigated', {
      predicate: (frame) => frame === page.mainFrame(),
    }),
    tenantListbox.press('Enter'),
  ]);
  await expect(page.getByRole('combobox', { name: 'Organizace' })).toContainText(authentication.tenants.second.name);
  const switchedSessionResponse = await page.request.get(sessionPath);
  expect(switchedSessionResponse.status()).toBe(200);
  expect(await switchedSessionResponse.json()).toMatchObject(
    expectedAuthenticatedSession(authentication, authentication.tenants.second),
  );
});

test('keeps keyboard logout operable after a Czech failure and succeeds on retry', async ({ authentication, page }) => {
  let failLogout = true;

  await gotoHydratedLogin(page, 'cs')
    .then(
      async () => await hydratedLoginForm(page).locator('input[name="login"]').fill(authentication.credentials.email),
    )
    .then(
      async () =>
        await hydratedLoginForm(page).locator('input[name="password"]').fill(authentication.credentials.password),
    )
    .then(async () => await hydratedLoginForm(page).getByRole('button', { name: 'Přihlásit se' }).click())
    .then(async () => await expect(page).toHaveURL(/\/cs\/?$/u))
    .then(
      async () =>
        await page.route('**/shell-super-app-api/auth/sign-out', async (route) => {
          if (failLogout) {
            failLogout = false;
            await route.abort('failed');
            return;
          }
          await route.continue();
        }),
    )
    .then(async () => {
      await waitForInteractiveAccountMenu(page);
      await page.getByRole('button', { name: 'E2E user' }).focus();
    })
    .then(async () => {
      await page.keyboard.press('Enter');
      // Profile precedes Logout. End selects the last menu item without a pointer.
      await page.getByRole('menu').press('End');
    })
    .then(
      async () =>
        await expect(page.getByRole('menuitem', { name: 'Odhlásit se' })).toHaveAttribute('data-highlighted', ''),
    )
    .then(async () => await page.getByRole('menu').press('Enter'))
    .then(
      async () =>
        await Promise.all([
          expect(page.getByRole('button', { name: 'E2E user' })).toBeVisible(),
          expect(page.getByText('Odhlášení selhalo. Zkuste to znovu.')).toBeVisible(),
          expect(page.getByRole('button', { name: 'E2E user' })).toBeFocused(),
        ]),
    )
    .then(async () => {
      await page.keyboard.press('Enter');
      await page.getByRole('menu').press('End');
    })
    .then(
      async () =>
        await expect(page.getByRole('menuitem', { name: 'Odhlásit se' })).toHaveAttribute('data-highlighted', ''),
    )
    .then(async () => await page.getByRole('menu').press('Enter'))
    .then(async () => await expect(page).toHaveURL(/\/cs\/login\/?$/u));
});

test('keeps the login form keyboard- and mobile-usable', async ({ page }) => {
  await page.setViewportSize({ height: 667, width: 375 });
  await gotoHydratedLogin(page, 'cs');
  const form = hydratedLoginForm(page);
  const loginInput = form.getByRole('textbox', {
    name: /^Přihlašovací jméno\s*\*$/u,
  });
  await expect(async () => {
    await loginInput.fill('hydration-probe');
    await form.getByRole('button', { name: 'Přihlásit se' }).click();
    await expect(page.getByText('Zadejte heslo.')).toBeInViewport({
      timeout: 1000,
    });
  }).toPass({ timeout: 5000 });
  await loginInput.clear();
  await loginInput.focus();
  await page.keyboard.press('Enter');
  await Promise.all([
    expect(loginInput).toBeFocused(),
    expect(page.getByText('Zadejte přihlašovací jméno.')).toBeInViewport(),
    expect(page.getByText('Zadejte heslo.')).toBeInViewport(),
  ]);
});

test('keeps the authenticated dashboard reachable without horizontal overflow at 375px', async ({
  authentication,
  page,
}) => {
  await page.setViewportSize({ height: 667, width: 375 });
  await login(page, 'en', authentication.credentials);
  await page.route(
    `**${shellAuthenticationApiContract.switchTenantPath}`,
    async (route) => await route.abort('failed'),
  );

  const dashboardHeader = page.locator('header[aria-label="Dashboard header"]');
  await expect(dashboardHeader).toBeInViewport();
  await expect(page.getByRole('button', { name: 'E2E user' })).toBeInViewport();
  const initialSessionResponse = await page.request.get(sessionPath);
  expect(initialSessionResponse.status()).toBe(200);
  expect(await initialSessionResponse.json()).toMatchObject(
    expectedAuthenticatedSession(authentication, authentication.tenants.first),
  );
  const navigationToggle = page.getByRole('button', { name: 'Toggle navigation' });
  await expect(navigationToggle).toHaveAttribute('aria-expanded', 'false');
  await navigationToggle.click();
  const dashboardSidebar = page.getByRole('complementary', { name: 'Dashboard sidebar' });
  await expect(dashboardSidebar).toBeInViewport();
  await expect(dashboardSidebar.getByRole('link', { exact: true, name: 'Home' })).toBeInViewport();
  const tenant = page.getByRole('combobox', { name: 'Current tenant' });
  await tenant.scrollIntoViewIfNeeded();
  await expect(tenant).toBeInViewport();
  await tenant.click();
  const secondTenant = page.getByRole('option', {
    name: authentication.tenants.second.name,
  });
  await expect(secondTenant).toBeInViewport();
  await secondTenant.click();
  await expect(page.getByText('Tenant switching failed. Try again.')).toBeInViewport();
  await expect(tenant).toContainText(authentication.tenants.first.name);
  const retainedSessionResponse = await page.request.get(sessionPath);
  expect(retainedSessionResponse.status()).toBe(200);
  expect(await retainedSessionResponse.json()).toMatchObject(
    expectedAuthenticatedSession(authentication, authentication.tenants.first),
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );
  await dashboardSidebar.getByRole('button', { name: 'Close navigation' }).click();
  await expect(dashboardSidebar).not.toBeVisible();
  await expect(dashboardHeader).toBeInViewport();
  await expect(page.getByRole('button', { name: 'E2E user' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );
});
