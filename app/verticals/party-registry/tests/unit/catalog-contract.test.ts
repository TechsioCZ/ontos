import { assert, expect, it } from 'effect-rstest';

import {
  comparePartyCatalog,
  expectedPartyTableCatalog,
} from '../../src/db/catalog.ts';

it('reports exact Party Registry catalog differences', () => {
  expect(expectedPartyTableCatalog.length).toBe(17);
  expect(expectedPartyTableCatalog[0]).toBe('party.counterparties');
  expect(expectedPartyTableCatalog.at(-1)).toBe('party.party_relationships');
  expect(comparePartyCatalog(expectedPartyTableCatalog.slice(1))).toEqual({
    missing: ['party.counterparties'],
    unexpected: [],
  });
  expect(
    comparePartyCatalog([...expectedPartyTableCatalog, 'party.unexpected'])
  ).toEqual({
    missing: [],
    unexpected: ['party.unexpected'],
  });
});

it('compares catalog sets without input order, duplicates, or previous results affecting differences', () => {
  const actual = ['party.z_extra', 'party.a_extra', 'party.z_extra'];
  const difference = comparePartyCatalog(actual);
  assert.deepEqual(difference, {
    missing: expectedPartyTableCatalog.toSorted(),
    unexpected: ['party.a_extra', 'party.z_extra'],
  });
  difference.missing.pop();
  assert.deepEqual(
    comparePartyCatalog(expectedPartyTableCatalog.toReversed()),
    {
      missing: [],
      unexpected: [],
    }
  );
  assert.deepEqual(actual, ['party.z_extra', 'party.a_extra', 'party.z_extra']);
});
