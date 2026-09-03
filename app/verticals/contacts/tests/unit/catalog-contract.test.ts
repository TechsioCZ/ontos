import assert from 'node:assert/strict';
import test from 'node:test';
import { compareContactsCatalog, expectedContactsTableCatalog } from '../../src/db/catalog.ts';

test('reports exact Contacts engagement profile catalog differences', () => {
  assert.deepEqual(expectedContactsTableCatalog, [
    'contacts.organization_engagement_profiles',
    'contacts.person_engagement_profiles',
  ]);
  assert.deepEqual(compareContactsCatalog(['contacts.organization_engagement_profiles']), {
    missing: ['contacts.person_engagement_profiles'],
    unexpected: [],
  });
});
