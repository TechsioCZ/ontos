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
