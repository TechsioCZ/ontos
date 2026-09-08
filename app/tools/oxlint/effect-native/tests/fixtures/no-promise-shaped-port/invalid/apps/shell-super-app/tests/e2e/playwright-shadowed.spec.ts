// expect-count: 1
import { test as base } from '@playwright/test';

async function ownedService() {
  return 'owned';
}

function register(base: any) {
  const test = base.extend({});
  test('shadowed factory', async () => {
    await ownedService();
  });
}
register({ extend: () => () => {} });
