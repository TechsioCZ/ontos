import { expect, test } from '@playwright/test';

test('renders the English login route with the localized UI-Kit controls', ({ page }) =>
  page
    .goto('/en/login')
    .then(() =>
      Promise.all([
        expect(page.getByRole('heading', { level: 1, name: 'Login' })).toBeVisible(),
        expect(page.getByRole('textbox', { name: /^Login\s*\*$/u })).toBeVisible(),
        expect(page.getByLabel(/^Password/u)).toBeVisible(),
        expect(page.getByRole('button', { name: 'Login' })).toBeVisible(),
        expect(page).toHaveTitle('Login'),
        expect(page.locator('meta[name="description"]')).toHaveAttribute(
          'content',
          'Sign in to the OntOS workspace.',
        ),
        expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow'),
      ]),
    ));

test('renders the Czech login route with Czech translations', ({ page }) =>
  page
    .goto('/cs/login')
    .then(() =>
      Promise.all([
        expect(page.getByRole('heading', { level: 1, name: 'Přihlášení' })).toBeVisible(),
        expect(page.getByRole('textbox', { name: /^Přihlašovací jméno\s*\*$/u })).toBeVisible(),
        expect(page.getByLabel(/^Heslo/u)).toBeVisible(),
        expect(page.getByRole('button', { name: 'Přihlásit se' })).toBeVisible(),
        expect(page).toHaveTitle('Přihlášení'),
        expect(page.locator('meta[name="description"]')).toHaveAttribute(
          'content',
          'Přihlaste se do pracovního prostoru OntOS.',
        ),
      ]),
    ));

test('shows Czech validation without stale English content', ({ page }) =>
  page
    .goto('/cs/login')
    .then(() => page.getByRole('button', { name: 'Přihlásit se' }).click())
    .then(() =>
      Promise.all([
        expect(page.getByText('Zadejte přihlašovací jméno.')).toBeVisible(),
        expect(page.getByText('Zadejte heslo.')).toBeVisible(),
        expect(page.getByText('Přihlašovací údaje nejsou úplné')).toHaveCount(1),
        expect(page.getByText('Vyplňte obě povinná pole.')).toBeVisible(),
        expect(page.getByText('Enter your login.')).toHaveCount(0),
        expect(page.getByText('Login details are incomplete')).toHaveCount(0),
      ]),
    ));

test('redirects the bare login path through locale detection', ({ page }) =>
  page.goto('/login').then(() => expect(page).toHaveURL(/\/(?:en|cs)\/login$/u)));

test('shows one Toast, both field errors, and focuses Login after an invalid submit', ({ page }) =>
  page
    .goto('/en/login')
    .then(() => page.getByRole('button', { name: 'Login' }).click())
    .then(() =>
      Promise.all([
        expect(page.getByRole('textbox', { name: /^Login\s*\*$/u })).toBeFocused(),
        expect(page.getByRole('textbox', { name: /^Login\s*\*$/u })).toHaveAttribute(
          'aria-invalid',
          'true',
        ),
        expect(page.getByLabel(/^Password/u)).toHaveAttribute('aria-invalid', 'true'),
        expect(page.getByText('Enter your login.')).toBeVisible(),
        expect(page.getByText('Enter your password.')).toBeVisible(),
        expect(page.getByText('Login details are incomplete')).toHaveCount(1),
        expect(page.getByText('Fill in both required fields.')).toBeVisible(),
      ]),
    ));

test('does not request or navigate when valid values are submitted', ({ page }) => {
  const submittedRequests: string[] = [];

  return page
    .goto('/en/login')
    .then(() => page.getByRole('textbox', { name: /^Login\s*\*$/u }).fill('admin'))
    .then(() => page.getByLabel(/^Password/u).fill('secret'))
    .then(() => {
      page.on('request', (request) => submittedRequests.push(request.url()));
      return page.getByRole('button', { name: 'Login' }).click();
    })
    .then(() =>
      Promise.all([
        expect(page).toHaveURL(/\/en\/login$/u),
        expect(page.getByText('Login details are incomplete')).toHaveCount(0),
      ]),
    )
    .then(() => expect(submittedRequests).toEqual([]));
});

test('keeps the login form usable at a mobile viewport', ({ page }) =>
  page
    .setViewportSize({ height: 667, width: 375 })
    .then(() => page.goto('/en/login'))
    .then(() =>
      Promise.all([
        expect(page.getByRole('heading', { level: 1, name: 'Login' })).toBeInViewport(),
        expect(page.getByRole('textbox', { name: /^Login\s*\*$/u })).toBeInViewport(),
        expect(page.getByLabel(/^Password/u)).toBeInViewport(),
        expect(page.getByRole('button', { name: 'Login' })).toBeInViewport(),
      ]),
    ));
