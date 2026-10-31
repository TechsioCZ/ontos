import { expect, test } from '@playwright/test';

// These tests need no accounts or database fixture. Blocking scripts keeps the real SSR document unhydrated.
test('an immediate click or Enter before hydration cannot put credentials in a URL', async ({ page }) => {
  await page.route('**/*', async (route) => {
    await (route.request().resourceType() === 'script' ? route.abort() : route.continue());
  });
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto('/cs/login', { waitUntil: 'domcontentloaded' });
  const form = page.locator('form').filter({ has: page.locator('input[name="password"]') });
  await expect(form).toHaveAttribute('method', 'post');
  await expect(form).toHaveAttribute('action', '/cs/login');
  await page.locator('input[name="login"]').fill('credential-url-probe@example.test');
  await page.locator('input[name="password"]').fill('credential-url-probe-secret');
  await expect(form.locator('button[type="submit"]')).toBeDisabled();
  await form.locator('button[type="submit"]').dispatchEvent('click');
  await page.locator('input[name="password"]').press('Enter');
  expect(new URL(page.url()).pathname).toBe('/cs/login');
  // Forced native submission bypasses the disabled button but still sends only a POST body.
  await Promise.all([
    page.waitForResponse((response) => response.status() === 303 && response.request().method() === 'POST'),
    form.evaluate((element: HTMLFormElement) => element.submit()),
  ]);
  await expect(page).toHaveURL(/\/cs\/login$/u);
  expect(requests.some((url) => url.includes('credential-url-probe') || url.includes('password='))).toBe(false);
});

test('a no-JavaScript browser gets the same POST-only safeguard', async ({ baseURL, browser }) => {
  const context = await browser.newContext({ baseURL: baseURL ?? 'http://127.0.0.1:3020', javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto('/cs/login');
    await page.locator('input[name="login"]').fill('no-js-probe@example.test');
    await page.locator('input[name="password"]').fill('no-js-probe-secret');
    await expect(page.locator('button[type="submit"]')).toBeDisabled();
    await page.locator('input[name="password"]').press('Enter');
    expect(new URL(page.url()).search).toBe('');
  } finally {
    await context.close();
  }
});
