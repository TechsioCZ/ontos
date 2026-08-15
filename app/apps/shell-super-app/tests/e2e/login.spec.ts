import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { crmApiContract } from '../../../../verticals/crm/shared/api.ts';
import { shellAuthenticationApiContract } from '../../shared/api.ts';
import {
  createAuthenticationFixture,
  e2eCredentials,
  e2eCustomers,
  e2eTenants,
} from './auth-fixture.ts';

const customerListPath = `${crmApiContract.basePath}/customers/list`;

const login = async (page: Page) => {
  await page.goto('/en/login');
  await page.getByRole('textbox', { name: /^Login\s*\*$/u }).fill(e2eCredentials.email);
  await page.getByLabel(/^Password/u).fill(e2eCredentials.password);
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL(/\/en\/?$/u);
  const sessionResponse = await page.request.get(shellAuthenticationApiContract.currentSessionPath);
  const sessionBody = await sessionResponse.text();
  expect(sessionResponse.status(), sessionBody).toBe(200);
  expect(sessionBody).toContain(e2eCredentials.email);
};

const customerResponse = (customer: typeof e2eCustomers.active | typeof e2eCustomers.archived) => ({
  archivedAt: 'archivedAt' in customer ? customer.archivedAt.toISOString() : null,
  createdAt: customer.createdAt.toISOString(),
  customerId: customer.customerId,
  name: customer.name,
  updatedAt: customer.updatedAt.toISOString(),
});

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

test('loads localized English and Czech CRM pages only after login', async ({ page }) => {
  await page.goto('/en/crm');
  await expect(page.getByRole('heading', { name: 'New Page' })).toHaveCount(0);
  await page.goto('/cs/crm');
  await expect(page.getByRole('heading', { name: 'Nová stránka' })).toHaveCount(0);

  await page.goto('/cs/login');
  await page
    .getByRole('textbox', { name: /^Přihlašovací jméno\s*\*$/u })
    .fill(e2eCredentials.email);
  await page.getByLabel(/^Heslo/u).fill(e2eCredentials.password);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/cs\/?$/u);

  const crmLink = page.locator('a[href="/cs/crm"]');
  await expect(crmLink).toHaveAttribute('href', '/cs/crm');
  await crmLink.click();

  await expect(page).toHaveURL(/\/cs\/crm\/?$/u);
  await expect(page.getByRole('heading', { name: 'Nová stránka' })).toBeVisible();
  await expect(page.getByText('Tato stránka je připravena k implementaci.')).toHaveCount(0);
  await expect(page.getByText('Zatím zde není žádný obsah.')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Postranní panel přehledu' })).toBeVisible();

  await page.goto('/en/crm');
  await expect(page).toHaveURL(/\/en\/crm\/?$/u);
  await expect(page.getByRole('heading', { name: 'New Page' })).toBeVisible();
  await expect(page.getByText('This page is ready for implementation.')).toHaveCount(0);
  await expect(page.getByText('No content has been added yet.')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Dashboard sidebar' })).toBeVisible();
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

test('keeps the login form keyboard- and mobile-usable', async ({ page }) => {
  await page.setViewportSize({ height: 667, width: 375 });
  await page.goto('/cs/login');
  const loginInput = page.getByRole('textbox', { name: /^Přihlašovací jméno\s*\*$/u });
  await expect(async () => {
    await loginInput.fill('hydration-probe');
    await page.getByRole('button', { name: 'Přihlásit se' }).click();
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

test('customers stay private anonymously and load real localized BFF data after login', async ({
  page,
}) => {
  let customerRequests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === customerListPath) {
      customerRequests += 1;
    }
  });

  await page.goto('/en/crm/customers');
  await expect(page.getByRole('heading', { name: 'Customers' })).toHaveCount(0);
  await expect(page.getByText(e2eCustomers.active.name)).toHaveCount(0);
  expect(customerRequests).toBe(0);

  await login(page);
  const englishResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === customerListPath &&
      response.request().method() === 'POST',
  );
  await page.goto('/en/crm/customers');
  const englishResponse = await englishResponsePromise;
  expect(englishResponse.status(), await englishResponse.text()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Customers' })).toBeVisible();
  await expect(page.getByText(e2eCustomers.active.name)).toBeVisible();
  await expect(page.getByText(e2eCustomers.archived.name)).toHaveCount(0);
  const sidebar = page.getByRole('complementary', { name: 'Dashboard sidebar' });
  const main = page.getByRole('main');
  await expect(sidebar).toHaveCount(1);
  await expect(sidebar.getByRole('link', { name: 'Crm' })).toHaveCount(1);
  await expect(sidebar.getByRole('link', { name: 'Crm' })).toHaveAttribute('href', '/en/crm');
  await expect(page.locator('header[aria-label="Dashboard header"]')).toHaveCount(1);
  const [sidebarBox, mainBox] = await Promise.all([sidebar.boundingBox(), main.boundingBox()]);
  if (sidebarBox === null || mainBox === null) {
    throw new Error('The authenticated dashboard layout must be measurable');
  }
  expect(sidebarBox.y).toBe(mainBox.y);
  expect(sidebarBox.x + sidebarBox.width).toBeLessThanOrEqual(mainBox.x);
  expect(sidebarBox.width).toBeLessThan(mainBox.width);
  const reviewScreenshotPath = process.env['ULTRAMODERN_REVIEW_SCREENSHOT_PATH'];
  if (reviewScreenshotPath !== undefined) {
    await page.screenshot({ fullPage: true, path: reviewScreenshotPath });
  }
  const czechResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === customerListPath &&
      response.request().method() === 'POST',
  );
  await page.goto('/cs/crm/customers');
  const czechResponse = await czechResponsePromise;
  expect(czechResponse.status(), await czechResponse.text()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Zákazníci' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Zákazníci' })).toBeVisible();
  await expect(page.getByText(e2eCustomers.active.name)).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Postranní panel přehledu' })).toHaveCount(
    1,
  );
});

test('customers empty state omits the table and pager', async ({ page }) => {
  await login(page);
  await page.route(`**${customerListPath}`, (route) =>
    route.fulfill({
      body: JSON.stringify({ items: [], nextOffset: null }),
      contentType: 'application/json',
      status: 200,
    }),
  );

  await page.goto('/en/crm/customers');
  await expect(page.getByText('No Customers match this filter.')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Customers' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Customer list pages' })).toHaveCount(0);
});

test('customers retry a temporary BFF failure from the keyboard and restore results focus', async ({
  page,
}) => {
  await login(page);
  let attempts = 0;
  await page.route(`**${customerListPath}`, (route) => {
    attempts += 1;
    if (attempts === 1) {
      return route.fulfill({
        body: JSON.stringify({
          _tag: 'CustomerListUnavailableProblem',
          detail: 'The E2E customer list is temporarily unavailable.',
          retryable: true,
          status: 503,
          title: 'Customer list unavailable',
          type: 'https://ontos.dev/problems/crm/customer-list-unavailable',
        }),
        contentType: 'application/problem+json',
        status: 503,
      });
    }
    return route.fulfill({
      body: JSON.stringify({ items: [customerResponse(e2eCustomers.active)], nextOffset: null }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/en/crm/customers');
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(e2eCustomers.active.name)).toBeVisible();
  await expect(page.getByTestId('customers-results')).toBeFocused();
  expect(attempts).toBe(2);
});

test('customers keep filter and pagination in the URL without page overflow at 375px', async ({
  page,
}) => {
  await page.setViewportSize({ height: 667, width: 375 });
  await login(page);
  const payloads: unknown[] = [];
  const longCustomer = {
    ...customerResponse(e2eCustomers.archived),
    name: `${e2eCustomers.archived.name} with a deliberately long business name`,
  };
  await page.route(`**${customerListPath}`, (route) => {
    const payload = route.request().postDataJSON();
    payloads.push(payload);
    return route.fulfill({
      body: JSON.stringify({
        items: [longCustomer],
        nextOffset: payload.offset === 0 ? 25 : null,
      }),
      contentType: 'application/json',
      status: 200,
    });
  });

  await page.goto('/en/crm/customers?view=compact');
  await expect(page.getByText(longCustomer.name)).toBeVisible();
  const status = page.getByRole('combobox', { name: 'Customer status' });
  await status.focus();
  await page.keyboard.press('Enter');
  const archived = page.getByRole('option', { name: 'Archived' });
  await expect(archived).toBeVisible();
  if ((await archived.getAttribute('data-highlighted')) === null) {
    await page.keyboard.press('ArrowDown');
  }
  await expect(archived).toHaveAttribute('data-highlighted', '');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/en\/crm\/customers\?view=compact&status=archived$/u);
  await expect(page.getByText(longCustomer.name)).toBeVisible();

  await page.getByRole('link', { name: 'Next' }).click();
  await expect(page).toHaveURL(/\/en\/crm\/customers\?view=compact&status=archived&offset=25$/u);
  await expect(page.getByText(longCustomer.name)).toBeVisible();
  expect(payloads).toContainEqual({ filter: 'active', limit: 25, offset: 0 });
  expect(payloads).toContainEqual({ filter: 'archived', limit: 25, offset: 0 });
  expect(payloads).toContainEqual({ filter: 'archived', limit: 25, offset: 25 });

  const overflow = page.getByTestId('customers-table-overflow');
  const dimensions = await overflow.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});
