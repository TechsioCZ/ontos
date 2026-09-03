import assert from 'node:assert/strict';
import test from 'node:test';
import { compareContactsCatalog, expectedContactsTableCatalog } from '../../src/db/catalog.ts';

test('reports exact Contacts catalog differences', () => {
  assert.deepEqual(expectedContactsTableCatalog, [
    'contacts.contacts',
    'contacts.customers',
    'contacts.gateway_assertion_redemptions',
  ]);
  assert.deepEqual(compareContactsCatalog(['contacts.contacts']), {
    missing: ['contacts.customers', 'contacts.gateway_assertion_redemptions'],
    unexpected: [],
  });
  assert.deepEqual(
    compareContactsCatalog([
      'contacts.contacts',
      'contacts.customers',
      'contacts.gateway_assertion_redemptions',
      'contacts.unexpected',
    ]),
    {
      missing: [],
      unexpected: ['contacts.unexpected'],
    },
  );
});
