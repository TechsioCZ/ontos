// expect-count: 1
import { test as base } from '@rstest/core';

const test = base.extend({});
async function ownedService() {
  return 'owned';
}
test('not Playwright', async () => {
  await ownedService();
});
