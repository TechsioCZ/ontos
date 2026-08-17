import { expect, test } from '@playwright/test';
import { shellGatewayContextContract } from '@app/shared-contracts';
import type { Page } from '@playwright/test';
import { crmApiContract } from '../../../../verticals/crm/shared/api.ts';
import { shellAuthenticationApiContract } from '../../shared/api.ts';
import {
  createAuthenticationFixture,
  e2eCredentials,
  e2eContacts,
  e2eCustomers,
  e2eTenants,
} from './auth-fixture.ts';

const customerListPath = `${crmApiContract.basePath}/customers/list`;
const customerDetailPath = `${crmApiContract.basePath}/customers/detail`;
const contactDetailPath = `${crmApiContract.basePath}/contacts/detail`;
const contactCreatePath = `${crmApiContract.basePath}/contacts/create`;
const contactEditPath = `${crmApiContract.basePath}/contacts/edit`;
const contactEditUrl = (language: 'cs' | 'en') =>
  `/${language}/crm/customers/${e2eContacts.active.customerId}/contacts/${e2eContacts.active.contactId}/edit`;
const contactEditDetailUrl = (language: 'cs' | 'en') =>
  `/${language}/crm/customers/${e2eContacts.active.customerId}/contacts/${e2eContacts.active.contactId}`;

const mockCrmGateway = async (page: Page) => {
  const payloads: unknown[] = [];
  await page.route(`**${shellGatewayContextContract.issueGatewayContextPath}`, (route) => {
    payloads.push(route.request().postDataJSON());
    return route.fulfill({
      body: JSON.stringify({ expiresAt: 2_000_000_000, token: 'e2e-crm-gateway-token' }),
      contentType: 'application/json',
      status: 200,
    });
  });
  return payloads;
};

const gotoHydratedLogin = async (page: Page, language: 'cs' | 'en') => {
  await page.goto(`/${language}/login`);
  await page.waitForFunction(() => {
    const form = document.querySelector('form');
    return form !== null && Object.keys(form).some((key) => key.startsWith('__reactProps$'));
  });
};

const login = async (page: Page) => {
  await gotoHydratedLogin(page, 'en');
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
  archivedAt: 'archivedAt' in customer ? customer.archivedAt : null,
  createdAt: customer.createdAt,
  customerId: customer.customerId,
  name: customer.name,
  updatedAt: customer.updatedAt,
});

const contactDetailResponse = (
  contact: typeof e2eContacts.active | typeof e2eContacts.archived,
) => ({
  archivedAt: 'archivedAt' in contact ? contact.archivedAt : null,
  contactId: contact.contactId,
  createdAt: contact.createdAt,
  customerId: contact.customerId,
  email: contact.email,
  name: contact.name,
  phone: contact.phone,
  updatedAt: contact.updatedAt,
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

  await gotoHydratedLogin(page, 'en');
  await expectDashboardAbsent();
  await gotoHydratedLogin(page, 'cs');
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

  await gotoHydratedLogin(page, 'en');
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

  await gotoHydratedLogin(page, 'cs');
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
  await gotoHydratedLogin(page, 'en');
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
  await gotoHydratedLogin(page, 'en');
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
  await gotoHydratedLogin(page, 'cs');
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
  await gotoHydratedLogin(page, 'cs');
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
  await gotoHydratedLogin(page, 'en');
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

test('customers empty state keeps the table and omits the pager', async ({ page }) => {
  await login(page);
  await page.route(`**${customerListPath}`, (route) =>
    route.fulfill({
      body: JSON.stringify({ items: [], nextOffset: null }),
      contentType: 'application/json',
      status: 200,
    }),
  );

  await page.goto('/en/crm/customers');
  const table = page.getByRole('table', { name: 'Customers' });
  await expect(table).toBeVisible();
  await expect(table.locator('tbody tr')).toHaveCount(0);
  await expect(page.getByText('No Customers match this filter.')).toHaveAttribute(
    'id',
    'customers-empty-description',
  );
  await expect(table).toHaveAttribute('aria-describedby', 'customers-empty-description');
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

test.describe('Customer detail flows', () => {
  test.describe.configure({ timeout: 90_000 });

  test('Customer detail stays private anonymously and renders real English and Czech BFF data', async ({
    page,
  }) => {
    let customerDetailRequests = 0;
    const payloads: unknown[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === customerDetailPath) {
        customerDetailRequests += 1;
        payloads.push(request.postDataJSON());
      }
    });

    await page.goto(`/en/crm/customers/${e2eCustomers.active.customerId}`);
    await expect(page.getByText(e2eCustomers.active.name)).toHaveCount(0);
    await page.goto(`/cs/crm/customers/${e2eCustomers.active.customerId}`);
    await expect(page.getByText(e2eCustomers.active.name)).toHaveCount(0);
    expect(customerDetailRequests).toBe(0);

    await login(page);
    const englishResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === customerDetailPath &&
        response.request().method() === 'POST',
    );
    await page.goto(`/en/crm/customers/${e2eCustomers.active.customerId}`);
    const englishResponse = await englishResponsePromise;
    expect(englishResponse.status(), await englishResponse.text()).toBe(200);
    await expect(page.getByRole('heading', { name: e2eCustomers.active.name })).toBeVisible();
    await expect(page.getByText(e2eCustomers.active.customerId)).toBeVisible();
    await expect(page.getByText('Active')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to Customers' })).toHaveAttribute(
      'href',
      '/en/crm/customers',
    );
    await page.setViewportSize({ height: 667, width: 375 });
    const czechResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === customerDetailPath &&
        response.request().method() === 'POST',
    );
    await page.goto(`/cs/crm/customers/${e2eCustomers.archived.customerId}`);
    const czechResponse = await czechResponsePromise;
    expect(czechResponse.status(), await czechResponse.text()).toBe(200);
    await expect(page.getByRole('heading', { name: e2eCustomers.archived.name })).toBeVisible();
    await expect(page.getByText(e2eCustomers.archived.customerId)).toBeVisible();
    await expect(page.getByText('Archivovaný')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Zpět na zákazníky' })).toHaveAttribute(
      'href',
      '/cs/crm/customers',
    );
    expect(payloads).toContainEqual({ customerId: e2eCustomers.active.customerId });
    expect(payloads).toContainEqual({ customerId: e2eCustomers.archived.customerId });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const screenshotPath = process.env['ULTRAMODERN_CUSTOMER_DETAIL_REVIEW_SCREENSHOT_PATH'];
    if (screenshotPath !== undefined) {
      await page.screenshot({ fullPage: true, path: screenshotPath });
    }
  });

  for (const [state, status, tag, message] of [
    ['not found', 404, 'CustomerDetailNotFoundProblem', 'This Customer could not be found.'],
    [
      'forbidden',
      403,
      'CustomerDetailForbiddenProblem',
      'You do not have permission to view this Customer.',
    ],
  ] as const) {
    test(`Customer detail renders a declared ${state} response without retry`, async ({ page }) => {
      await login(page);
      await page.route(`**${customerDetailPath}`, (route) =>
        route.fulfill({
          body: JSON.stringify({
            _tag: tag,
            detail: message,
            status,
            title: message,
            type: `https://ontos.dev/problems/crm/customer-detail-${status}`,
          }),
          contentType: 'application/problem+json',
          status,
        }),
      );

      await page.goto(`/en/crm/customers/${e2eCustomers.active.customerId}`);
      await expect(page.getByText(message)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    });
  }

  test('Customer detail retries an unavailable response with the exact URL ID and restores focus', async ({
    page,
  }) => {
    await login(page);
    const payloads: unknown[] = [];
    let attempts = 0;
    await page.route(`**${customerDetailPath}`, (route) => {
      attempts += 1;
      payloads.push(route.request().postDataJSON());
      if (attempts === 1) {
        return route.fulfill({
          body: JSON.stringify({
            _tag: 'CustomerDetailUnavailableProblem',
            detail: 'The E2E Customer is temporarily unavailable.',
            retryable: true,
            status: 503,
            title: 'Customer unavailable',
            type: 'https://ontos.dev/problems/crm/customer-detail-unavailable',
          }),
          contentType: 'application/problem+json',
          status: 503,
        });
      }
      return route.fulfill({
        body: JSON.stringify(customerResponse(e2eCustomers.active)),
        contentType: 'application/json',
        status: 200,
      });
    });

    await page.goto(`/en/crm/customers/${e2eCustomers.active.customerId}`);
    await expect(page.getByText('The Customer is temporarily unavailable. Try again.')).toBeVisible(
      { timeout: 60_000 },
    );
    const retry = page.getByRole('button', { name: 'Try again' });
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: e2eCustomers.active.name })).toBeVisible();
    await expect(page.getByTestId('customer-detail-results')).toBeFocused();
    expect(attempts).toBe(2);
    expect(payloads).toEqual([
      { customerId: e2eCustomers.active.customerId },
      { customerId: e2eCustomers.active.customerId },
    ]);
  });
});

test.describe('Contact create flows', () => {
  test.describe.configure({ timeout: 90_000 });

  const contactCorsHeaders = {
    'access-control-allow-origin': 'http://127.0.0.1:3020',
  } as const;
  const contactResponse = {
    archivedAt: null,
    contactId: '7c000000-0000-4000-8000-000000000001',
    createdAt: '2026-08-16T08:00:00.000Z',
    customerId: e2eCustomers.active.customerId,
    email: 'ada@example.test',
    name: 'Ada Lovelace',
    phone: '123456789',
    updatedAt: '2026-08-16T08:00:00.000Z',
  } as const;

  test('Contact create stays private, renders localized forms, and submits the real page request', async ({
    page,
  }) => {
    let contactRequests = 0;
    const payloads: unknown[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === contactCreatePath) {
        contactRequests += 1;
      }
    });

    await page.goto(`/en/crm/customers/${e2eCustomers.active.customerId}/contacts/new`);
    await expect(page.getByRole('heading', { name: 'Create Contact' })).toHaveCount(0);
    await page.goto(`/cs/crm/customers/${e2eCustomers.active.customerId}/contacts/new`);
    await expect(page.getByRole('heading', { name: 'Vytvořit kontakt' })).toHaveCount(0);
    expect(contactRequests).toBe(0);

    await login(page);
    const gatewayPayloads = await mockCrmGateway(page);
    await page.route(`**${contactCreatePath}`, (route) => {
      if (route.request().method() === 'OPTIONS') {
        return route.fallback();
      }
      payloads.push(route.request().postDataJSON());
      return route.fulfill({
        body: JSON.stringify(contactResponse),
        contentType: 'application/json',
        headers: contactCorsHeaders,
        status: 200,
      });
    });

    await page.goto(`/cs/crm/customers/${e2eCustomers.active.customerId}/contacts/new`);
    await expect(page.getByRole('heading', { name: 'Vytvořit kontakt' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Jméno kontaktu/u })).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^E-mail/u })).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Telefon/u })).toHaveAttribute(
      'placeholder',
      'Telefonní číslo',
    );
    await expect(
      page.getByRole('combobox', { name: 'Vybrat zemi telefonního čísla' }),
    ).toBeVisible();

    await page.setViewportSize({ height: 667, width: 375 });
    await page.goto(`/en/crm/customers/${e2eCustomers.active.customerId}/contacts/new`);
    await expect(page.getByRole('heading', { name: 'Create Contact' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to Customer' })).toHaveAttribute(
      'href',
      `/en/crm/customers/${e2eCustomers.active.customerId}`,
    );
    await page.getByRole('textbox', { name: /^Contact name/u }).fill(contactResponse.name);
    await page.getByRole('textbox', { name: /^Email/u }).fill(contactResponse.email);
    await page.getByRole('textbox', { name: /^Phone/u }).fill(contactResponse.phone);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const screenshotPath = process.env['ULTRAMODERN_CONTACT_CREATE_REVIEW_SCREENSHOT_PATH'];
    if (screenshotPath !== undefined) {
      await page.screenshot({ fullPage: true, path: screenshotPath });
    }

    await page.getByRole('textbox', { name: /^Email/u }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => payloads.length).toBe(1);
    expect(payloads).toEqual([
      {
        customerId: e2eCustomers.active.customerId,
        email: contactResponse.email,
        name: contactResponse.name,
        phone: contactResponse.phone,
      },
    ]);
    await expect(page).toHaveURL(`/en/crm/customers/${e2eCustomers.active.customerId}`);
    await expect.poll(() => gatewayPayloads.length).toBe(2);
    expect(gatewayPayloads).toEqual([{ audience: 'crm' }, { audience: 'crm' }]);
  });

  test('Contact create preserves values and reuses its key after a mocked uncertain failure', async ({
    page,
  }) => {
    await login(page);
    const gatewayPayloads = await mockCrmGateway(page);
    let attempts = 0;
    const headers: { readonly correlationId?: string; readonly idempotencyKey?: string }[] = [];
    await page.route(`**${contactCreatePath}`, (route) => {
      if (route.request().method() === 'OPTIONS') {
        return route.fallback();
      }
      attempts += 1;
      const requestHeaders = route.request().headers();
      headers.push({
        correlationId: requestHeaders['x-correlation-id'],
        idempotencyKey: requestHeaders['idempotency-key'],
      });
      if (attempts === 1) {
        return route.fulfill({
          body: JSON.stringify({
            _tag: 'CrmUnavailableProblem',
            detail: 'The E2E Contact service is unavailable.',
            retryable: true,
            status: 503,
            title: 'Contact service unavailable',
            type: 'https://ontos.dev/problems/crm-unavailable',
          }),
          contentType: 'application/problem+json',
          headers: contactCorsHeaders,
          status: 503,
        });
      }
      return route.fulfill({
        body: JSON.stringify(contactResponse),
        contentType: 'application/json',
        headers: contactCorsHeaders,
        status: 200,
      });
    });

    await page.goto(`/en/crm/customers/${e2eCustomers.active.customerId}/contacts/new`);
    await page.getByRole('textbox', { name: /^Contact name/u }).fill(contactResponse.name);
    await page.getByRole('textbox', { name: /^Email/u }).fill(contactResponse.email);
    await page.getByRole('textbox', { name: /^Phone/u }).fill(contactResponse.phone);
    await page.getByRole('button', { name: 'Create Contact' }).click();

    await expect(page.getByText(/request may have completed/u)).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Contact name/u })).toHaveValue(
      contactResponse.name,
    );
    await page.getByRole('button', { name: 'Create Contact' }).click();
    await expect.poll(() => attempts).toBe(2);
    expect(headers[0]?.idempotencyKey).toBeTruthy();
    expect(headers[1]?.idempotencyKey).toBe(headers[0]?.idempotencyKey);
    expect(headers[1]?.correlationId).not.toBe(headers[0]?.correlationId);
    await expect(page).toHaveURL(`/en/crm/customers/${e2eCustomers.active.customerId}`);
    await expect.poll(() => gatewayPayloads.length).toBe(3);
    expect(gatewayPayloads).toEqual([
      { audience: 'crm' },
      { audience: 'crm' },
      { audience: 'crm' },
    ]);
  });
});

test.describe('Contact detail flows', () => {
  test.describe.configure({ timeout: 90_000 });

  test('Contact detail stays private anonymously and renders real English and Czech BFF data', async ({
    page,
  }) => {
    let contactRequests = 0;
    const payloads: unknown[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === contactDetailPath) {
        contactRequests += 1;
        payloads.push(request.postDataJSON());
      }
    });

    await page.goto(
      `/en/crm/customers/${e2eContacts.active.customerId}/contacts/${e2eContacts.active.contactId}`,
    );
    await expect(page.getByText(e2eContacts.active.name)).toHaveCount(0);
    await page.goto(
      `/cs/crm/customers/${e2eContacts.archived.customerId}/contacts/${e2eContacts.archived.contactId}`,
    );
    await expect(page.getByText(e2eContacts.archived.name)).toHaveCount(0);
    expect(contactRequests).toBe(0);

    await login(page);
    const englishResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === contactDetailPath &&
        response.request().method() === 'POST',
    );
    await page.goto(
      `/en/crm/customers/${e2eContacts.active.customerId}/contacts/${e2eContacts.active.contactId}`,
    );
    const englishResponse = await englishResponsePromise;
    expect(englishResponse.status(), await englishResponse.text()).toBe(200);
    await expect(page.getByRole('heading', { name: e2eContacts.active.name })).toBeVisible();
    await expect(page.getByText(e2eContacts.active.contactId)).toBeVisible();
    await expect(page.getByText(e2eContacts.active.customerId)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Send email to this Contact' })).toHaveAttribute(
      'href',
      `mailto:${e2eContacts.active.email}`,
    );
    await expect(page.getByRole('link', { name: 'Call this Contact' })).toHaveAttribute(
      'href',
      `tel:${e2eContacts.active.phone}`,
    );
    await expect(page.getByRole('link', { name: 'Back to Customer' })).toHaveAttribute(
      'href',
      `/en/crm/customers/${e2eContacts.active.customerId}`,
    );

    await page.setViewportSize({ height: 667, width: 375 });
    const czechResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === contactDetailPath &&
        response.request().method() === 'POST',
    );
    await page.goto(
      `/cs/crm/customers/${e2eContacts.archived.customerId}/contacts/${e2eContacts.archived.contactId}`,
    );
    const czechResponse = await czechResponsePromise;
    expect(czechResponse.status(), await czechResponse.text()).toBe(200);
    await expect(page.getByRole('heading', { name: e2eContacts.archived.name })).toBeVisible();
    await expect(page.getByText(e2eContacts.archived.email)).toBeVisible();
    await expect(page.getByText('Archivovaný')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Zpět na zákazníka' })).toHaveAttribute(
      'href',
      `/cs/crm/customers/${e2eContacts.archived.customerId}`,
    );
    const emailLayout = await page
      .getByRole('link', { name: 'Napsat e-mail tomuto kontaktu' })
      .evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const style = getComputedStyle(element);
        return {
          className: element.className,
          display: style.display,
          parentClientWidth: element.parentElement?.clientWidth,
          parentScrollWidth: element.parentElement?.scrollWidth,
          rectangles: Array.from(range.getClientRects(), (rectangle) => ({
            right: rectangle.right,
            width: rectangle.width,
          })),
          scrollWidth: element.scrollWidth,
          width: element.clientWidth,
          wordBreak: style.wordBreak,
        };
      });
    expect(emailLayout.rectangles.length, JSON.stringify(emailLayout)).toBeGreaterThan(1);
    expect(
      emailLayout.rectangles.every((rectangle) => rectangle.right <= 375 && rectangle.width <= 375),
    ).toBe(true);
    expect(payloads).toEqual([
      { contactId: e2eContacts.active.contactId },
      { contactId: e2eContacts.archived.contactId },
    ]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const screenshotPath = process.env['ULTRAMODERN_CONTACT_DETAIL_REVIEW_SCREENSHOT_PATH'];
    if (screenshotPath !== undefined) {
      await page.screenshot({ fullPage: true, path: screenshotPath });
    }
  });

  test('Contact detail rejects malformed IDs and suppresses a Contact under the wrong Customer', async ({
    page,
  }) => {
    await login(page);
    let attempts = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === contactDetailPath) {
        attempts += 1;
      }
    });

    await page.goto('/en/crm/customers/not-a-uuid/contacts/not-a-contact');
    await expect(
      page.getByText('This Contact could not be found for the selected Customer.'),
    ).toBeVisible({ timeout: 60_000 });
    expect(attempts).toBe(0);

    await page.goto(
      `/en/crm/customers/${e2eCustomers.archived.customerId}/contacts/${e2eContacts.active.contactId}`,
    );
    await expect(
      page.getByText('This Contact could not be found for the selected Customer.'),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(e2eContacts.active.name)).toHaveCount(0);
    await expect(page.getByText(e2eContacts.active.email)).toHaveCount(0);
    expect(attempts).toBe(1);
  });

  for (const [state, status, tag, message] of [
    [
      'not found',
      404,
      'ContactDetailNotFoundProblem',
      'This Contact could not be found for the selected Customer.',
    ],
    [
      'forbidden',
      403,
      'ContactDetailForbiddenProblem',
      'You do not have permission to view this Contact.',
    ],
  ] as const) {
    test(`Contact detail renders a declared ${state} response without retry`, async ({ page }) => {
      await login(page);
      await page.route(`**${contactDetailPath}`, (route) =>
        route.fulfill({
          body: JSON.stringify({
            _tag: tag,
            detail: message,
            status,
            title: message,
            type: `https://ontos.dev/problems/crm/contact-detail-${status}`,
          }),
          contentType: 'application/problem+json',
          status,
        }),
      );

      await page.goto(
        `/en/crm/customers/${e2eContacts.active.customerId}/contacts/${e2eContacts.active.contactId}`,
      );
      await expect(page.getByText(message)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    });
  }

  test('Contact detail retries a 503 from the keyboard with only the Contact ID and restores focus', async ({
    page,
  }) => {
    await login(page);
    const payloads: unknown[] = [];
    let attempts = 0;
    await page.route(`**${contactDetailPath}`, (route) => {
      attempts += 1;
      payloads.push(route.request().postDataJSON());
      if (attempts === 1) {
        return route.fulfill({
          body: JSON.stringify({
            _tag: 'ContactDetailUnavailableProblem',
            detail: 'The E2E Contact is temporarily unavailable.',
            retryable: true,
            status: 503,
            title: 'Contact unavailable',
            type: 'https://ontos.dev/problems/crm/contact-detail-unavailable',
          }),
          contentType: 'application/problem+json',
          status: 503,
        });
      }
      return route.fulfill({
        body: JSON.stringify(contactDetailResponse(e2eContacts.active)),
        contentType: 'application/json',
        status: 200,
      });
    });

    await page.goto(
      `/en/crm/customers/${e2eContacts.active.customerId}/contacts/${e2eContacts.active.contactId}`,
    );
    await expect(page.getByText('The Contact is temporarily unavailable. Try again.')).toBeVisible({
      timeout: 60_000,
    });
    const retry = page.getByRole('button', { name: 'Try again' });
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: e2eContacts.active.name })).toBeVisible();
    await expect(page.getByTestId('contact-detail-results')).toBeFocused();
    expect(attempts).toBe(2);
    expect(payloads).toEqual([
      { contactId: e2eContacts.active.contactId },
      { contactId: e2eContacts.active.contactId },
    ]);
  });
});

test.describe('Contact edit flows', () => {
  test.describe.configure({ timeout: 90_000 });

  const contactCorsHeaders = {
    'access-control-allow-origin': 'http://127.0.0.1:3020',
  } as const;
  const editedContact = {
    ...contactDetailResponse(e2eContacts.active),
    email: 'grace@example.test',
    name: 'Grace Hopper',
    phone: '987654321',
    updatedAt: '2026-08-16T10:00:00.000Z',
  } as const;
  test('Contact edit stays private, prefills localized forms, submits the strict request, and remains responsive', async ({
    page,
  }) => {
    let anonymousCrmRequests = 0;
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname === contactDetailPath || pathname === contactEditPath) {
        anonymousCrmRequests += 1;
      }
    });

    await page.goto(contactEditUrl('en'));
    await expect(page.getByRole('heading', { name: 'Edit Contact' })).toHaveCount(0);
    await page.goto(contactEditUrl('cs'));
    await expect(page.getByRole('heading', { name: 'Upravit kontakt' })).toHaveCount(0);
    expect(anonymousCrmRequests).toBe(0);

    await login(page);
    await mockCrmGateway(page);
    const detailPayloads: unknown[] = [];
    const editPayloads: unknown[] = [];
    const editHeaders: { readonly correlationId?: string; readonly idempotencyKey?: string }[] = [];
    await page.route(`**${contactDetailPath}`, (route) => {
      if (route.request().method() === 'OPTIONS') {
        return route.fallback();
      }
      detailPayloads.push(route.request().postDataJSON());
      return route.fulfill({
        body: JSON.stringify(contactDetailResponse(e2eContacts.active)),
        contentType: 'application/json',
        headers: contactCorsHeaders,
        status: 200,
      });
    });
    await page.route(`**${contactEditPath}`, (route) => {
      if (route.request().method() === 'OPTIONS') {
        return route.fallback();
      }
      editPayloads.push(route.request().postDataJSON());
      const headers = route.request().headers();
      editHeaders.push({
        correlationId: headers['x-correlation-id'],
        idempotencyKey: headers['idempotency-key'],
      });
      return route.fulfill({
        body: JSON.stringify(editedContact),
        contentType: 'application/json',
        headers: contactCorsHeaders,
        status: 200,
      });
    });

    await page.goto(contactEditUrl('cs'));
    await expect(page.getByRole('heading', { name: 'Upravit kontakt' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Jméno kontaktu/u })).toHaveValue(
      e2eContacts.active.name,
    );
    await expect(page.getByRole('link', { name: 'Zpět na kontakt' })).toHaveAttribute(
      'href',
      contactEditDetailUrl('cs'),
    );

    await page.setViewportSize({ height: 667, width: 375 });
    await page.goto(contactEditUrl('en'));
    await expect(page.getByRole('heading', { name: 'Edit Contact' })).toBeVisible();
    await page.getByRole('textbox', { name: /^Contact name/u }).fill('  Grace Hopper  ');
    await page.getByRole('textbox', { name: /^Email/u }).fill('  Grace@Example.Test  ');
    await page.getByRole('textbox', { name: /^Phone/u }).fill('  987654321  ');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const screenshotPath = process.env['ULTRAMODERN_CONTACT_EDIT_REVIEW_SCREENSHOT_PATH'];
    if (screenshotPath !== undefined) {
      await page.screenshot({ fullPage: true, path: screenshotPath });
    }

    await page.getByRole('textbox', { name: /^Email/u }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => editPayloads.length).toBe(1);
    expect(editPayloads).toEqual([
      {
        contactId: e2eContacts.active.contactId,
        email: 'Grace@Example.Test',
        name: 'Grace Hopper',
        phone: '98 765 432 1',
      },
    ]);
    expect(editHeaders[0]?.idempotencyKey).toBeTruthy();
    expect(editHeaders[0]?.correlationId).toBeTruthy();
    await expect(page).toHaveURL(contactEditDetailUrl('en'));
    expect(
      detailPayloads.every(
        (payload) =>
          JSON.stringify(payload) ===
          JSON.stringify({
            contactId: e2eContacts.active.contactId,
          }),
      ),
    ).toBe(true);
  });

  test('Contact edit retains values and reuses its key after a typed uncertain failure', async ({
    page,
  }) => {
    await login(page);
    await mockCrmGateway(page);
    let attempts = 0;
    const headers: { readonly correlationId?: string; readonly idempotencyKey?: string }[] = [];
    await page.route(`**${contactDetailPath}`, (route) =>
      route.fulfill({
        body: JSON.stringify(contactDetailResponse(e2eContacts.active)),
        contentType: 'application/json',
        headers: contactCorsHeaders,
        status: 200,
      }),
    );
    await page.route(`**${contactEditPath}`, (route) => {
      if (route.request().method() === 'OPTIONS') {
        return route.fallback();
      }
      attempts += 1;
      const requestHeaders = route.request().headers();
      headers.push({
        correlationId: requestHeaders['x-correlation-id'],
        idempotencyKey: requestHeaders['idempotency-key'],
      });
      if (attempts === 1) {
        return route.fulfill({
          body: JSON.stringify({
            _tag: 'CrmUnavailableProblem',
            detail: 'The E2E Contact service is unavailable.',
            retryable: true,
            status: 503,
            title: 'Contact service unavailable',
            type: 'https://ontos.dev/problems/crm-unavailable',
          }),
          contentType: 'application/problem+json',
          headers: contactCorsHeaders,
          status: 503,
        });
      }
      return route.fulfill({
        body: JSON.stringify(editedContact),
        contentType: 'application/json',
        headers: contactCorsHeaders,
        status: 200,
      });
    });

    await page.goto(contactEditUrl('en'));
    await expect(page.getByRole('textbox', { name: /^Contact name/u })).toHaveValue(
      e2eContacts.active.name,
    );
    await page.getByRole('button', { name: 'Save Contact' }).click();
    await expect(page.getByText(/request may have completed/u)).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Contact name/u })).toHaveValue(
      e2eContacts.active.name,
    );
    await page.getByRole('button', { name: 'Save Contact' }).click();

    await expect.poll(() => attempts).toBe(2);
    expect(headers[0]?.idempotencyKey).toBeTruthy();
    expect(headers[1]?.idempotencyKey).toBe(headers[0]?.idempotencyKey);
    expect(headers[1]?.correlationId).not.toBe(headers[0]?.correlationId);
    await expect(page).toHaveURL(contactEditDetailUrl('en'));
  });
});
