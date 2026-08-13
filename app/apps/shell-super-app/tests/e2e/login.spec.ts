import { expect, test } from '@playwright/test';
import { shellAuthenticationApiContract } from '../../shared/api.ts';
import { createAuthenticationFixture, e2eCredentials, e2eTenants } from './auth-fixture.ts';

let cleanupFixture: (() => Promise<void>) | undefined;

test.beforeAll(() =>
  createAuthenticationFixture().then((cleanup) => {
    cleanupFixture = cleanup;
  }),
);

test.afterAll(() => cleanupFixture?.());

test('renders the exact anonymous English and Czech home states', ({ page }) =>
  page
    .goto('/en/')
    .then(() =>
      Promise.all([
        expect(page.getByRole('link', { name: 'Login' })).toBeVisible(),
        expect(page.getByRole('link')).toHaveCount(1),
        expect(page.getByRole('button')).toHaveCount(0),
        expect(page.getByRole('checkbox')).toHaveCount(0),
        expect(page.locator('header[aria-label]')).toHaveCount(0),
        expect(page.getByRole('complementary')).toHaveCount(0),
        expect(page.getByRole('region')).toHaveCount(0),
      ]),
    )
    .then(() => page.goto('/cs/'))
    .then(() =>
      Promise.all([
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
  const expectDashboardAbsent = () =>
    Promise.all([
      expect(page.locator('header[aria-label]')).toHaveCount(0),
      expect(page.getByRole('complementary')).toHaveCount(0),
      expect(page.locator('button[aria-haspopup="menu"]')).toHaveCount(0),
    ]);

  await page.goto('/en/login');
  await expectDashboardAbsent();
  await page.goto('/cs/login');
  await expectDashboardAbsent();
});

test('shows one generic error for invalid English credentials', ({ page }) =>
  page
    .goto('/en/login')
    .then(() => page.getByRole('textbox', { name: /^Login\s*\*$/u }).fill(e2eCredentials.email))
    .then(() => page.getByLabel(/^Password/u).fill('wrong-password'))
    .then(() => page.getByRole('button', { name: 'Login' }).click())
    .then(() =>
      Promise.all([
        expect(page.getByText('Unable to log in')).toHaveCount(1),
        expect(page.getByText('The email address or password is invalid.')).toBeVisible(),
        expect(page.getByRole('textbox', { name: /^Login\s*\*$/u })).toBeFocused(),
      ]),
    ));

test('logs a user in without any server-error response', async ({ page }, testInfo) => {
  const { baseURL } = testInfo.project.use;
  if (typeof baseURL !== 'string') {
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

  await page.goto('/en/login');
  await page.getByRole('textbox', { name: /^Login\s*\*$/u }).fill(e2eCredentials.email);
  await page.getByLabel(/^Password/u).fill(e2eCredentials.password);

  const signInResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === shellAuthenticationApiContract.signInPath &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Login' }).click();
  const signInResponse = await signInResponsePromise;

  expect(signInResponse.status(), 'The sign-in endpoint should accept valid credentials').toBe(200);
  await expect(page).toHaveURL(/\/en\/?$/u);
  await expect(page.getByRole('button', { name: 'E2E user' })).toBeVisible();
  await expect(page.getByText(e2eCredentials.email)).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Dashboard sidebar' })).toBeVisible();
  await expect(page.locator('header[aria-label="Dashboard header"]')).toBeVisible();
  expect(serverErrors, 'Login and the authenticated page must not return HTTP 5xx').toEqual([]);
});

test('loads CRM at its public Shell URL after login', async ({ page }) => {
  await page.goto('/cs/login');
  await page
    .getByRole('textbox', { name: /^Přihlašovací jméno\s*\*$/u })
    .fill(e2eCredentials.email);
  await page.getByLabel(/^Heslo/u).fill(e2eCredentials.password);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/cs\/?$/u);

  const crmLink = page.getByRole('link', { name: 'CRM' });
  await expect(crmLink).toHaveAttribute('href', '/cs/crm');
  await crmLink.click();

  await expect(page).toHaveURL(/\/cs\/crm\/?$/u);
  await expect(page.getByRole('heading', { name: 'Nová stránka' })).toBeVisible();
  await expect(page.getByText('Zatím zde není žádný obsah.')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Postranní panel přehledu' })).toBeVisible();
});

test('keeps authenticated Shell chrome on search and guarded direct-target routes', async ({
  page,
}) => {
  await page.goto('/en/login');
  await page.getByRole('textbox', { name: /^Login\s*\*$/u }).fill(e2eCredentials.email);
  await page.getByLabel(/^Password/u).fill(e2eCredentials.password);
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/en\/?$/u);

  const expectPersistentShell = async (path: string, status: string) => {
    await page.goto(path);
    await expect(page.getByRole('complementary', { name: 'Dashboard sidebar' })).toBeVisible();
    await expect(page.locator('header[aria-label="Dashboard header"]')).toBeVisible();
    await expect(page.getByText(status)).toBeVisible();
  };
  await expectPersistentShell('/en/search', 'Select a legal entity before searching.');
  await expectPersistentShell(
    '/en/modules/not-installed',
    'Select a legal entity before opening a module.',
  );
  await expectPersistentShell(
    '/en/resources/not-installed/example/missing',
    'Select a legal entity before opening a resource.',
  );
});

test('persists an English session, logs out, clears the cookie, and stays anonymous', ({ page }) =>
  page
    .goto('/en/login')
    .then(() => page.getByRole('textbox', { name: /^Login\s*\*$/u }).fill(e2eCredentials.email))
    .then(() => page.getByLabel(/^Password/u).fill(e2eCredentials.password))
    .then(() => page.getByRole('button', { name: 'Login' }).click())
    .then(() => expect(page).toHaveURL(/\/en\/?$/u))
    .then(() =>
      Promise.all([
        expect(page.getByRole('button', { name: 'E2E user' })).toBeVisible(),
        expect(page.getByText(e2eCredentials.email)).toBeVisible(),
        expect(page.getByRole('link', { name: 'Home' })).toHaveCount(1),
      ]),
    )
    .then(() => page.reload())
    .then(() => expect(page.getByRole('button', { name: 'E2E user' })).toBeVisible())
    .then(() => page.getByRole('button', { name: 'E2E user' }).click())
    .then(() => page.getByRole('menuitem', { name: 'Logout' }).click())
    .then(() =>
      Promise.all([
        expect(page.getByRole('link', { name: 'Login' })).toBeVisible(),
        expect(page.getByRole('button')).toHaveCount(0),
        expect(page.locator('header[aria-label]')).toHaveCount(0),
        expect(page.getByRole('complementary')).toHaveCount(0),
      ]),
    )
    .then(() => page.reload())
    .then(() => expect(page.getByRole('link', { name: 'Login' })).toBeVisible()));

test('switches tenant by pointer, fully reloads, and persists the selected context', async ({
  page,
}) => {
  await page.goto('/en/login');
  await page.getByRole('textbox', { name: /^Login\s*\*$/u }).fill(e2eCredentials.email);
  await page.getByLabel(/^Password/u).fill(e2eCredentials.password);
  await page.getByRole('button', { name: 'Login' }).click();
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
  await page.goto('/cs/login');
  await page
    .getByRole('textbox', { name: /^Přihlašovací jméno\s*\*$/u })
    .fill(e2eCredentials.email);
  await page.getByLabel(/^Heslo/u).fill(e2eCredentials.password);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/cs\/?$/u);
  await page.route(`**${shellAuthenticationApiContract.switchTenantPath}`, (route) => {
    if (failSwitch) {
      failSwitch = false;
      return route.abort('failed');
    }
    return route.continue();
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
  if ((await secondTenantOption.getAttribute('data-highlighted')) === null) {
    await page.keyboard.press('ArrowDown');
  }
  if ((await secondTenantOption.getAttribute('data-highlighted')) === null) {
    await page.keyboard.press('ArrowDown');
  }
  await expect(secondTenantOption).toHaveAttribute('data-highlighted', '');
  await Promise.all([
    page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
    page.keyboard.press('Enter'),
  ]);
  await expect(page.getByRole('combobox', { name: 'Aktuální tenant' })).toContainText(
    e2eTenants.second.name,
  );
});

test('keeps keyboard logout operable after a Czech failure and succeeds on retry', ({ page }) => {
  let failLogout = true;

  return page
    .goto('/cs/login')
    .then(() =>
      page.getByRole('textbox', { name: /^Přihlašovací jméno\s*\*$/u }).fill(e2eCredentials.email),
    )
    .then(() => page.getByLabel(/^Heslo/u).fill(e2eCredentials.password))
    .then(() => page.getByRole('button', { name: 'Přihlásit se' }).click())
    .then(() => expect(page).toHaveURL(/\/cs\/?$/u))
    .then(() =>
      page.route('**/shell-super-app-api/auth/sign-out', (route) => {
        if (failLogout) {
          failLogout = false;
          return route.abort('failed');
        }
        return route.continue();
      }),
    )
    .then(() => page.getByRole('button', { name: 'E2E user' }).focus())
    .then(() => page.keyboard.press('Enter'))
    .then(() =>
      expect(page.getByRole('menuitem', { name: 'Odhlásit se' })).toHaveAttribute(
        'data-highlighted',
        '',
      ),
    )
    .then(() => page.getByRole('menuitem', { name: 'Odhlásit se' }).click())
    .then(() =>
      Promise.all([
        expect(page.getByRole('button', { name: 'E2E user' })).toBeVisible(),
        expect(page.getByText('Odhlášení selhalo. Zkuste to znovu.')).toBeVisible(),
        expect(page.getByRole('button', { name: 'E2E user' })).toBeFocused(),
      ]),
    )
    .then(() => page.keyboard.press('Enter'))
    .then(() =>
      expect(page.getByRole('menuitem', { name: 'Odhlásit se' })).toHaveAttribute(
        'data-highlighted',
        '',
      ),
    )
    .then(() => page.getByRole('menuitem', { name: 'Odhlásit se' }).click())
    .then(() => expect(page.getByRole('link', { name: 'Přihlásit se' })).toBeVisible());
});

test('keeps the login form keyboard- and mobile-usable', ({ page }) =>
  page
    .setViewportSize({ height: 667, width: 375 })
    .then(() => page.goto('/cs/login'))
    .then(() => page.getByRole('textbox', { name: /^Přihlašovací jméno\s*\*$/u }).focus())
    .then(() => page.keyboard.press('Enter'))
    .then(() =>
      Promise.all([
        expect(page.getByRole('textbox', { name: /^Přihlašovací jméno\s*\*$/u })).toBeFocused(),
        expect(page.getByText('Zadejte přihlašovací jméno.')).toBeInViewport(),
        expect(page.getByText('Zadejte heslo.')).toBeInViewport(),
      ]),
    ));

test('keeps the authenticated dashboard reachable without horizontal overflow at 375px', async ({
  page,
}) => {
  await page.setViewportSize({ height: 667, width: 375 });
  await page.goto('/en/login');
  await page.getByRole('textbox', { name: /^Login\s*\*$/u }).fill(e2eCredentials.email);
  await page.getByLabel(/^Password/u).fill(e2eCredentials.password);
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/en\/?$/u);
  await page.route(`**${shellAuthenticationApiContract.switchTenantPath}`, (route) =>
    route.abort('failed'),
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
