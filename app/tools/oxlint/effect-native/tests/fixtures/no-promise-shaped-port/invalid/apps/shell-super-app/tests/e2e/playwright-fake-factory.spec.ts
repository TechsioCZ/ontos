// expect-count: 1
import { test as base } from './fake-playwright';

const test = base.extend({}).extend({});
async function ownedService() {
  return 'owned';
}
test('fake factory', async () => {
  await ownedService();
});
