import { expect, it } from '@app/effect-rstest';
import { comparePartyCatalog, expectedPartyTableCatalog } from '../../src/db/catalog.ts';

it('reports exact Party Registry catalog differences', () => {
  expect(expectedPartyTableCatalog.length).toBe(17);
  expect(expectedPartyTableCatalog[0]).toBe('party.counterparties');
  expect(expectedPartyTableCatalog.at(-1)).toBe('party.party_relationships');
  expect(comparePartyCatalog(expectedPartyTableCatalog.slice(1))).toEqual({
    missing: ['party.counterparties'],
    unexpected: [],
  });
  expect(comparePartyCatalog([...expectedPartyTableCatalog, 'party.unexpected'])).toEqual({
    missing: [],
    unexpected: ['party.unexpected'],
  });
});
