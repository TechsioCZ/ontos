import assert from 'node:assert/strict';
import test from 'node:test';
import { compareContactsCatalog, expectedContactsTableCatalog } from '../../src/db/catalog.ts';

test('reports exact Contacts catalog differences', () => {
  assert.deepEqual(expectedContactsTableCatalog, ['contacts.contacts', 'contacts.customers']);
  assert.deepEqual(compareContactsCatalog(['contacts.contacts']), {
    missing: ['contacts.customers'],
    unexpected: [],
  });
  assert.deepEqual(
    compareContactsCatalog(['contacts.contacts', 'contacts.customers', 'contacts.unexpected']),
    {
      missing: [],
      unexpected: ['contacts.unexpected'],
    },
  );
});
