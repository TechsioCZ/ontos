import { test as base } from '@playwright/test';

const alias = base;
const test = alias.extend<{ ready: boolean }>({ ready: true });
const extended = test['extend']({}).extend({});
const chained = base.extend({})[`extend`]({});
const finalTest = chained;

async function gotoHydratedLogin(page: { goto: (url: string) => Promise<void> }) {
  await page.goto('/login');
}

async function visit(page: { goto: (url: string) => Promise<void> }) {
  await gotoHydratedLogin(page);
}

test('extended browser test', async ({ page }) => {
  await visit(page);
});
extended.beforeEach(async ({ page }) => {
  await visit(page);
});
finalTest('chained browser test', async ({ page }) => {
  await Promise.all([page].map(async (browserPage) => gotoHydratedLogin(browserPage)));
});
