import assert from 'node:assert/strict';
import test from 'node:test';
import { comparePartyCatalog, expectedPartyTableCatalog } from '../../src/db/catalog.ts';

test('reports exact Party Registry catalog differences', () => {
  assert.equal(expectedPartyTableCatalog.length, 17);
  assert.equal(expectedPartyTableCatalog[0], 'party.counterparties');
  assert.equal(expectedPartyTableCatalog.at(-1), 'party.party_relationships');
  assert.deepEqual(comparePartyCatalog(expectedPartyTableCatalog.slice(1)), {
    missing: ['party.counterparties'],
    unexpected: [],
  });
  assert.deepEqual(comparePartyCatalog([...expectedPartyTableCatalog, 'party.unexpected']), {
    missing: [],
    unexpected: ['party.unexpected'],
  });
});

test('compares catalog sets without input order, duplicates, or previous results affecting differences', () => {
  const actual = ['party.z_extra', 'party.a_extra', 'party.z_extra'];
  const difference = comparePartyCatalog(actual);
  assert.deepEqual(difference, {
    missing: expectedPartyTableCatalog.toSorted(),
    unexpected: ['party.a_extra', 'party.z_extra'],
  });
  difference.missing.pop();
  assert.deepEqual(comparePartyCatalog(expectedPartyTableCatalog.toReversed()), {
    missing: [],
    unexpected: [],
  });
  assert.deepEqual(actual, ['party.z_extra', 'party.a_extra', 'party.z_extra']);
});
