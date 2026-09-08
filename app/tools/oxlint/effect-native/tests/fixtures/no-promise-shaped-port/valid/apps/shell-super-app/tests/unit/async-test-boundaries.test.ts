import { it, test, rstest } from 'effect-rstest';
import { test as browserTest } from '@playwright/test';
import { Effect } from 'effect';

it.effect('Effect callback', () => Effect.succeed('ready'));
it.live('Promise boundary', () => Effect.promise(async () => 'ready'));
test('SDK mock', () => {
  const sdk = rstest.fn(async () => 'ready');
  sdk();
});
browserTest('browser contract', async ({ page }) => {
  await page.goto('/');
});
// Spelling alone is not evidence of an imported test registration.
function unrelated(test: (name: string, callback: () => void) => void) {
  test('foreign callback', async () => {});
}
