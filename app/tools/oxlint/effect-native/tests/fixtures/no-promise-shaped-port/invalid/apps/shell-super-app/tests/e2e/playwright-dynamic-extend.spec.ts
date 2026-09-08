// expect-count: 1
import { test as base } from '@playwright/test';

declare const method: string;
const test = base[method]({});
async function ownedService() {
  return 'owned';
}
test('unknown factory', async () => {
  await ownedService();
});
