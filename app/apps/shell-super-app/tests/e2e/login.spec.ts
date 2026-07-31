import { expect, test } from '@playwright/test';
import { createAuthenticationFixture, e2eCredentials } from './auth-fixture.ts';

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
        expect(page.getByRole('region')).toHaveCount(0),
      ]),
    ));

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

test('persists an English session, logs out, clears the cookie, and stays anonymous', ({ page }) =>
  page
    .goto('/en/login')
    .then(() => page.getByRole('textbox', { name: /^Login\s*\*$/u }).fill(e2eCredentials.email))
    .then(() => page.getByLabel(/^Password/u).fill(e2eCredentials.password))
    .then(() => page.getByRole('button', { name: 'Login' }).click())
    .then(() => expect(page).toHaveURL(/\/en\/?$/u))
    .then(() =>
      Promise.all([
        expect(page.getByText('E2E user')).toBeVisible(),
        expect(page.getByText(e2eCredentials.email)).toBeVisible(),
        expect(page.getByRole('button', { name: 'Logout' })).toHaveCount(1),
        expect(page.getByRole('link')).toHaveCount(0),
      ]),
    )
    .then(() => page.reload())
    .then(() => expect(page.getByRole('button', { name: 'Logout' })).toBeVisible())
    .then(() => page.getByRole('button', { name: 'Logout' }).click())
    .then(() =>
      Promise.all([
        expect(page.getByRole('link', { name: 'Login' })).toBeVisible(),
        expect(page.getByRole('button')).toHaveCount(0),
      ]),
    )
    .then(() => page.reload())
    .then(() => expect(page.getByRole('link', { name: 'Login' })).toBeVisible()));

test('keeps the Czech authenticated state on logout failure and succeeds on retry', ({ page }) => {
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
    .then(() => page.getByRole('button', { name: 'Odhlásit se' }).click())
    .then(() =>
      Promise.all([
        expect(page.getByText('E2E user')).toBeVisible(),
        expect(page.getByText('Odhlášení selhalo. Zkuste to znovu.')).toBeVisible(),
        expect(page.getByRole('button', { name: 'Odhlásit se' })).toBeVisible(),
      ]),
    )
    .then(() => page.getByRole('button', { name: 'Odhlásit se' }).click())
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
