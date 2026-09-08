// expect-count: 1
import { test as base } from '@playwright/test';

let test = base.extend({});
test = anotherTest;
async function ownedService() {
  return 'owned';
}
test('mutable factory', async () => {
  await ownedService();
});
