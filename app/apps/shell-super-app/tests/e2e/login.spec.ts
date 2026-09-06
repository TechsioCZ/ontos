import { Predicate } from 'effect';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { shellAuthenticationApiContract } from '../../shared/api.ts';
import { createAuthenticationFixture, e2eCredentials, e2eTenants } from './auth-fixture.ts';

const hydratedLoginForm = (page: Page) => page.locator('form[data-e2e-hydrated-login="true"]');

const gotoHydratedLogin = async (page: Page, language: 'cs' | 'en') => {
  await page.goto(`/${language}/login`);
  await page.waitForFunction(() => {
    const forms = [...document.querySelectorAll<HTMLFormElement>('form')].filter(
      (form) => form.querySelector('input[name="login"]') !== null,
    );
    let hydratedForm: HTMLFormElement | undefined;
    for (const form of forms) {
      if (Object.keys(form).some((key) => key.startsWith('__reactProps$'))) {
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

let cleanupFixture: (() => Promise<void>) | undefined;

test.beforeAll(
  async () =>
    await createAuthenticationFixture().then((cleanup) => {
      cleanupFixture = cleanup;
    }),
);

test.afterAll(async () => await cleanupFixture?.());

test('renders the exact anonymous English and Czech home states', async ({ page }) =>
  await page
    .goto('/en/')
    .then(
      async () =>
        await Promise.all([
          expect(page.getByRole('link', { name: 'Login' })).toBeVisible(),
          expect(page.getByRole('link')).toHaveCount(1),
          expect(page.getByRole('button')).toHaveCount(0),
          expect(page.getByRole('checkbox')).toHaveCount(0),
          expect(page.locator('header[aria-label]')).toHaveCount(0),
          expect(page.getByRole('complementary')).toHaveCount(0),
          expect(page.getByRole('region')).toHaveCount(0),
        ]),
    )
    .then(async () => await page.goto('/cs/'))
    .then(
      async () =>
        await Promise.all([
          expect(page.getByRole('link', { name: 'Přihlásit se' })).toBeVisible(),
          expect(page.getByRole('link')).toHaveCount(1),
          expect(page.getByRole('button')).toHaveCount(0),
          expect(page.getByRole('checkbox')).toHaveCount(0),
          expect(page.locator('header[aria-label]')).toHaveCount(0),
          expect(page.getByRole('complementary')).toHaveCount(0),
          expect(page.getByRole('region')).toHaveCount(0),
        ]),
    ));

test('keeps English and Czech login pages free of authenticated dashboard chrome', async ({
  page,
}) => {
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

test('shows one generic error for invalid English credentials', async ({ page }) =>
  await gotoHydratedLogin(page, 'en')
    .then(
      async () =>
        await hydratedLoginForm(page)
          .getByRole('textbox', { name: /^Login\s*\*$/u })
          .fill(e2eCredentials.email),
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
          expect(page.getByText('The email address or password is invalid.')).toHaveCount(1),
          expect(page.getByRole('textbox', { name: /^Login\s*\*$/u })).toBeFocused(),
        ]),
    ));

test('logs a user in without any server-error response', async ({ page }, testInfo) => {
  const { baseURL } = testInfo.project.use;
  if (!Predicate.isString(baseURL)) {
    throw new TypeError('The login E2E test requires a configured base URL');
  }

  const applicationOrigin = new URL(baseURL).origin;
  const serverErrors: string[] = [];

  page.on('response', (response) => {
    const responseURL = new URL(response.url());
    if (
      responseURL.origin === applicationOrigin &&
      response.status() >= 500 &&
      response.status() < 600
    ) {
      serverErrors.push(
        `${response.request().method()} ${responseURL.pathname}${responseURL.search} returned ${response.status()}`,
      );
    }
  });

  await gotoHydratedLogin(page, 'en');
  const form = hydratedLoginForm(page);
  await form.getByRole('textbox', { name: /^Login\s*\*$/u }).fill(e2eCredentials.email);
  await form.getByLabel(/^Password/u).fill(e2eCredentials.password);

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
  await expect(page.getByText(e2eCredentials.email)).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Dashboard sidebar' })).toBeVisible();
  await expect(page.locator('header[aria-label="Dashboard header"]')).toBeVisible();
  expect(serverErrors, 'Login and the authenticated page must not return HTTP 5xx').toEqual([]);
});

test('loads localized English and Czech Contacts pages only after login', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/en/contacts');
  await expect(page.getByRole('heading', { name: 'Contacts' })).toHaveCount(0);
  await page.goto('/cs/contacts');
  await expect(page.getByRole('heading', { name: 'Contacts' })).toHaveCount(0);

  await gotoHydratedLogin(page, 'cs');
  const form = hydratedLoginForm(page);
  await form
    .getByRole('textbox', { name: /^Přihlašovací jméno\s*\*$/u })
    .fill(e2eCredentials.email);
  await form.getByLabel(/^Heslo/u).fill(e2eCredentials.password);
  await form.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/cs\/?$/u);
  await expect(page.getByText('Nasazení modulu je dočasně nedostupné.')).toHaveCount(0);

  const contactsLink = page.locator('a[href="/cs/contacts"]');
  await expect(contactsLink).toHaveAttribute('href', '/cs/contacts');
  await contactsLink.click();

  await expect(page).toHaveURL(/\/cs\/contacts\/?$/u);
  await expect(page.getByRole('heading', { name: 'Kontakty' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Modul' })).toHaveCount(0);
  await expect(
    page.getByText(
      'Party Registry uchovává kanonické strany, protistrany a jejich profily zapojení v jednom modulu.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Tato stránka je připravena k implementaci.')).toHaveCount(0);
  await expect(page.getByText('Zatím zde není žádný obsah.')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Postranní panel přehledu' })).toBeVisible();

  await page.goto('/en/contacts');
  await expect(page).toHaveURL(/\/en\/contacts\/?$/u);
  await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Module' })).toHaveCount(0);
  await expect(
    page.getByText(
      'Party Registry keeps canonical Parties, Counterparties, and their engagement profiles in one module.',
    ),
  ).toBeVisible();
  await expect(page.getByText('This page is ready for implementation.')).toHaveCount(0);
  await expect(page.getByText('No content has been added yet.')).toHaveCount(0);
  await expect(page.getByText('The module is temporarily unavailable. Try again.')).toHaveCount(0);
  const dashboardSidebar = page.getByRole('complementary', { name: 'Dashboard sidebar' });
  await expect(dashboardSidebar).toBeVisible();
  const [sidebarBox, mainBox] = await Promise.all([
    dashboardSidebar.boundingBox(),
    page.locator('main').boundingBox(),
  ]);
  expect(sidebarBox?.width).toBe(256);
  expect(mainBox?.x).toBe(256);
  expect(
    pageErrors.filter((message) =>
      message.includes('FederatedI18nBoundary must be used within ModernI18nProvider'),
    ),
  ).toEqual([]);
});

test('keeps authenticated Shell chrome on search and guarded direct-target routes', async ({
  page,
}) => {
  await gotoHydratedLogin(page, 'en');
  const form = hydratedLoginForm(page);
  await form.getByRole('textbox', { name: /^Login\s*\*$/u }).fill(e2eCredentials.email);
  await form.getByLabel(/^Password/u).fill(e2eCredentials.password);
  await form.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/en\/?$/u);

  const expectPersistentShell = async (path: string, status: string) => {
    await page.goto(path);
    await expect(page.getByRole('complementary', { name: 'Dashboard sidebar' })).toBeVisible();
    await expect(page.locator('header[aria-label="Dashboard header"]')).toBeVisible();
    await expect(page.getByText(status)).toBeVisible();
  };
  await expectPersistentShell('/en/search', 'No authorized results found.');
  await expectPersistentShell(
    '/en/modules/not-installed',
    'You do not have permission to open this module.',
  );
  await expectPersistentShell(
    '/en/resources/not-installed/example/missing',
    'You do not have permission to view this resource.',
  );
});

test('persists an English session, logs out, clears the cookie, and stays anonymous', async ({
  page,
}) =>
  await gotoHydratedLogin(page, 'en')
    .then(
      async () =>
        await hydratedLoginForm(page)
          .getByRole('textbox', { name: /^Login\s*\*$/u })
          .fill(e2eCredentials.email),
    )
    .then(
      async () =>
        await hydratedLoginForm(page)
          .getByLabel(/^Password/u)
          .fill(e2eCredentials.password),
    )
    .then(async () => await hydratedLoginForm(page).getByRole('button', { name: 'Login' }).click())
    .then(async () => await expect(page).toHaveURL(/\/en\/?$/u))
    .then(
      async () =>
        await Promise.all([
          expect(page.getByRole('button', { name: 'E2E user' })).toBeVisible(),
          expect(page.getByText(e2eCredentials.email)).toBeVisible(),
          expect(page.getByRole('link', { name: 'Home' })).toHaveCount(1),
        ]),
    )
    .then(async () => await page.reload())
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
    .then(async () => await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible()));

test('switches tenant by pointer, fully reloads, and persists the selected context', async ({
  page,
}) => {
  await gotoHydratedLogin(page, 'en');
  const form = hydratedLoginForm(page);
  await form.getByRole('textbox', { name: /^Login\s*\*$/u }).fill(e2eCredentials.email);
  await form.getByLabel(/^Password/u).fill(e2eCredentials.password);
  await form.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/en\/?$/u);

  const tenant = page.getByRole('combobox', { name: 'Current tenant' });
  await expect(tenant).toContainText(e2eTenants.first.name);
  await expect(page.getByText(e2eTenants.first.tenantId)).toBeVisible();
  await tenant.click();
  const switchResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === shellAuthenticationApiContract.switchTenantPath &&
      response.request().method() === 'POST',
  );
  await Promise.all([
    page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
    page.getByRole('option', { name: e2eTenants.second.name }).click(),
  ]);
  const switchResponse = await switchResponsePromise;
  expect(switchResponse.status()).toBe(200);
  await expect(page.getByRole('combobox', { name: 'Current tenant' })).toContainText(
    e2eTenants.second.name,
  );
  await expect(page.getByRole('button', { name: 'E2E user second tenant' })).toBeVisible();
  await expect(page.getByText(e2eTenants.second.principalId)).toBeVisible();
  await expect(page.getByText(e2eTenants.second.tenantId)).toBeVisible();

  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Current tenant' })).toContainText(
    e2eTenants.second.name,
  );
  await expect(page.getByRole('button', { name: 'E2E user second tenant' })).toBeVisible();
});

test('retains Czech tenant context after one failed switch and supports keyboard retry', async ({
  page,
}) => {
  let failSwitch = true;
  await gotoHydratedLogin(page, 'cs');
  const form = hydratedLoginForm(page);
  await form
    .getByRole('textbox', { name: /^Přihlašovací jméno\s*\*$/u })
    .fill(e2eCredentials.email);
  await form.getByLabel(/^Heslo/u).fill(e2eCredentials.password);
  await form.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/cs\/?$/u);
  await page.route(`**${shellAuthenticationApiContract.switchTenantPath}`, async (route) => {
    if (failSwitch) {
      failSwitch = false;
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  const tenant = page.getByRole('combobox', { name: 'Aktuální tenant' });
  await expect(tenant).toContainText(e2eTenants.first.name);
  await tenant.click();
  await page.getByRole('option', { name: e2eTenants.second.name }).click();
  await expect(page.getByText('Přepnutí tenantu selhalo. Zkuste to znovu.')).toBeVisible();
  await expect(tenant).toContainText(e2eTenants.first.name);
  await expect(page.getByText(e2eTenants.first.tenantId)).toBeVisible();

  await tenant.focus();
  await page.keyboard.press('Enter');
  const secondTenantOption = page.getByRole('option', { name: e2eTenants.second.name });
  await expect(secondTenantOption).toBeVisible();
  const tenantListbox = page.getByRole('listbox');
  await tenantListbox.press('End');
  const secondTenantOptionId = await secondTenantOption.getAttribute('id');
  expect(secondTenantOptionId).not.toBeNull();
  await expect(tenantListbox).toHaveAttribute('aria-activedescendant', secondTenantOptionId ?? '');
  await Promise.all([
    page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
    tenantListbox.press('Enter'),
  ]);
  await expect(page.getByRole('combobox', { name: 'Aktuální tenant' })).toContainText(
    e2eTenants.second.name,
  );
});

test('keeps keyboard logout operable after a Czech failure and succeeds on retry', async ({
  page,
}) => {
  let failLogout = true;

  await gotoHydratedLogin(page, 'cs')
    .then(
      async () =>
        await hydratedLoginForm(page).locator('input[name="login"]').fill(e2eCredentials.email),
    )
    .then(
      async () =>
        await hydratedLoginForm(page)
          .locator('input[name="password"]')
          .fill(e2eCredentials.password),
    )
    .then(
      async () =>
        await hydratedLoginForm(page).getByRole('button', { name: 'Přihlásit se' }).click(),
    )
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
    .then(async () => await page.getByRole('button', { name: 'E2E user' }).focus())
    .then(async () => await page.keyboard.press('Enter'))
    .then(
      async () =>
        await expect(page.getByRole('menuitem', { name: 'Odhlásit se' })).toHaveAttribute(
          'data-highlighted',
          '',
        ),
    )
    .then(async () => await page.getByRole('menuitem', { name: 'Odhlásit se' }).click())
    .then(
      async () =>
        await Promise.all([
          expect(page.getByRole('button', { name: 'E2E user' })).toBeVisible(),
          expect(page.getByText('Odhlášení selhalo. Zkuste to znovu.')).toBeVisible(),
          expect(page.getByRole('button', { name: 'E2E user' })).toBeFocused(),
        ]),
    )
    .then(async () => await page.keyboard.press('Enter'))
    .then(
      async () =>
        await expect(page.getByRole('menuitem', { name: 'Odhlásit se' })).toHaveAttribute(
          'data-highlighted',
          '',
        ),
    )
    .then(async () => await page.getByRole('menuitem', { name: 'Odhlásit se' }).click())
    .then(async () => await expect(page).toHaveURL(/\/cs\/login\/?$/u));
});

test('keeps the login form keyboard- and mobile-usable', async ({ page }) => {
  await page.setViewportSize({ height: 667, width: 375 });
  await gotoHydratedLogin(page, 'cs');
  const form = hydratedLoginForm(page);
  const loginInput = form.getByRole('textbox', { name: /^Přihlašovací jméno\s*\*$/u });
  await expect(async () => {
    await loginInput.fill('hydration-probe');
    await form.getByRole('button', { name: 'Přihlásit se' }).click();
    await expect(page.getByText('Zadejte heslo.')).toBeInViewport({ timeout: 1000 });
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
  page,
}) => {
  await page.setViewportSize({ height: 667, width: 375 });
  await gotoHydratedLogin(page, 'en');
  const form = hydratedLoginForm(page);
  await form.getByRole('textbox', { name: /^Login\s*\*$/u }).fill(e2eCredentials.email);
  await form.getByLabel(/^Password/u).fill(e2eCredentials.password);
  await form.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/en\/?$/u);
  await page.route(
    `**${shellAuthenticationApiContract.switchTenantPath}`,
    async (route) => await route.abort('failed'),
  );

  await expect(page.getByRole('complementary', { name: 'Dashboard sidebar' })).toBeInViewport();
  await expect(page.locator('header[aria-label="Dashboard header"]')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'E2E user' })).toBeInViewport();
  await expect(page.getByRole('region', { name: 'Authenticated identity' })).toBeInViewport();
  await expect(page.getByRole('link', { name: 'Home' })).toBeInViewport();
  const tenant = page.getByRole('combobox', { name: 'Current tenant' });
  await expect(tenant).toBeInViewport();
  await tenant.click();
  const secondTenant = page.getByRole('option', { name: e2eTenants.second.name });
  await expect(secondTenant).toBeInViewport();
  await secondTenant.click();
  await expect(page.getByText('Tenant switching failed. Try again.')).toBeInViewport();
  await expect(tenant).toContainText(e2eTenants.first.name);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});
