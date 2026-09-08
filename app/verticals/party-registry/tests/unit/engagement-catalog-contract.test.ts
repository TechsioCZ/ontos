import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareContactsCatalog,
  expectedContactsTableCatalog,
} from '../../src/db/engagement-catalog.ts';

test('reports exact Contacts table catalog differences', () => {
  assert.deepEqual(expectedContactsTableCatalog, [
    'contacts.gateway_assertion_redemptions',
    'contacts.organization_engagement_profiles',
    'contacts.person_engagement_profiles',
  ]);
  assert.deepEqual(
    compareContactsCatalog(['contacts.organization_engagement_profiles']),
    {
      missing: [
        'contacts.gateway_assertion_redemptions',
        'contacts.person_engagement_profiles',
      ],
      unexpected: [],
    }
  );
});

test('keeps Contacts inventory separate while rejecting duplicate unknown tables once', () => {
  assert.deepEqual(
    compareContactsCatalog([
      ...expectedContactsTableCatalog,
      'party.counterparties',
      'party.counterparties',
    ]),
    { missing: [], unexpected: ['party.counterparties'] }
  );
  assert.deepEqual(compareContactsCatalog([]), {
    missing: expectedContactsTableCatalog.toSorted(),
    unexpected: [],
  });
});
