import { expect, test } from '@playwright/test';

// These tests need no accounts or database fixture. Blocking scripts keeps the real SSR document unhydrated.
// Before hydration the sign-in form is a POST form without credential fields: effect-form renders the fields once
// the page hydrates, so nothing can be typed, and a forced native submission still sends only a POST body.
test('before hydration the sign-in form offers no credential field and submits only by POST', async ({ page }) => {
  await page.route('**/*', async (route) => {
    await (route.request().resourceType() === 'script' ? route.abort() : route.continue());
  });
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto('/cs/login', { waitUntil: 'domcontentloaded' });
  const form = page.locator('form[action="/cs/login"]');
  await expect(form).toHaveAttribute('method', 'post');
  await expect(page.locator('input[name="login"], input[name="password"]')).toHaveCount(0);
  await Promise.all([
    page.waitForResponse((response) => response.status() === 303 && response.request().method() === 'POST'),
    form.evaluate((element: HTMLFormElement) => element.submit()),
  ]);
  await expect(page).toHaveURL(/\/cs\/login$/u);
  expect(requests.some((url) => url.includes('password='))).toBe(false);
});

test('a no-JavaScript browser gets no credential field to type into', async ({ baseURL, browser }) => {
  const context = await browser.newContext({ baseURL: baseURL ?? 'http://127.0.0.1:3020', javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto('/cs/login');
    await expect(page.locator('form[action="/cs/login"]')).toHaveAttribute('method', 'post');
    await expect(page.locator('input[name="login"], input[name="password"]')).toHaveCount(0);
    expect(new URL(page.url()).search).toBe('');
  } finally {
    await context.close();
  }
});
