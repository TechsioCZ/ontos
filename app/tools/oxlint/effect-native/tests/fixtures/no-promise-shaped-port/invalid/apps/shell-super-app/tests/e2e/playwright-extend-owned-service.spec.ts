// expect-count: 2
import { test as base } from '@playwright/test';
import { test as unitTest } from '@app/effect-rstest';

const test = base.extend({});
async function ownedService() {
  return 'owned';
}
test('browser caller', async () => {
  await ownedService();
});
unitTest('owned async program', async () => {
  await ownedService();
});
