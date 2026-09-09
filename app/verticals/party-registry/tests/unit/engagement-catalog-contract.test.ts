import { assert, expect, it } from 'effect-rstest';

import { compareContactsCatalog, expectedContactsTableCatalog } from '../../src/db/engagement-catalog.ts';

it('reports exact Contacts table catalog differences', () => {
  expect(expectedContactsTableCatalog).toEqual([
    'contacts.gateway_assertion_redemptions',
    'contacts.organization_engagement_profiles',
    'contacts.person_engagement_profiles',
  ]);
  expect(compareContactsCatalog(['contacts.organization_engagement_profiles'])).toEqual({
    missing: ['contacts.gateway_assertion_redemptions', 'contacts.person_engagement_profiles'],
    unexpected: [],
  });
});

it('keeps Contacts inventory separate while rejecting duplicate unknown tables once', () => {
  assert.deepEqual(
    compareContactsCatalog([...expectedContactsTableCatalog, 'party.counterparties', 'party.counterparties']),
    { missing: [], unexpected: ['party.counterparties'] },
  );
  assert.deepEqual(compareContactsCatalog([]), {
    missing: expectedContactsTableCatalog.toSorted(),
    unexpected: [],
  });
});
