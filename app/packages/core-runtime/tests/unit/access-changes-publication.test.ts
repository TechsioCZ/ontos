import { expect, it } from 'effect-rstest';

import {
  decodeCatalogEntry,
  projectPublishedCatalog,
  publishedCapabilityKeys,
} from '../../src/access/changes/publication.ts';
import type { DeclarationInput } from './access-changes-fixtures.ts';
import { declaration, failureOf, succeeded } from './access-changes-fixtures.ts';

const published = (input: DeclarationInput) => ({
  declaration: declaration(input),
  moduleId: 'test',
  published: true,
});

const withheld = (input: DeclarationInput) => ({
  declaration: declaration(input),
  moduleId: 'test',
  published: false,
});

it('puts published declarations in the configurable catalog and withholds the rest', () => {
  const catalog = succeeded(
    projectPublishedCatalog([
      published({ key: 'test.party.add-note' }),
      withheld({ key: 'test.party.upcoming', modes: ['run', 'propose'], risk: 'sensitive' }),
    ]),
  );
  expect(catalog.entries.map(({ key }) => key)).toEqual(['test.party.add-note']);
  expect(catalog.unpublished).toEqual([{ capabilityKey: 'test.party.upcoming', moduleId: 'test' }]);
});

it('withholds a whole module release until the module publishes it', () => {
  const catalog = succeeded(projectPublishedCatalog([withheld({ key: 'test.party.add-note' })]));
  expect(catalog.entries).toEqual([]);
  expect(publishedCapabilityKeys(catalog.entries).size).toBe(0);
  expect(catalog.unpublished).toHaveLength(1);
});

it('keeps the catalog-relevant fields of a declaration and drops the rest', () => {
  const catalog = succeeded(
    projectPublishedCatalog([
      published({
        amountInput: 'amount',
        key: 'test.invoice.pay',
        kind: 'action',
        modes: ['run', 'propose', 'approve'],
        risk: 'critical',
        selectors: ['assigned', 'team'],
      }),
    ]),
  );
  expect(catalog.entries[0]).toEqual({
    amountInput: 'amount',
    key: 'test.invoice.pay',
    kind: 'action',
    modes: ['run', 'propose', 'approve'],
    moduleKey: 'test',
    placement: { group: 'parties', level: 'basic' },
    risk: 'critical',
    selectors: ['assigned', 'team'],
  });
});

it('refuses a declaration that names a key of another module', () => {
  const foreign = {
    declaration: declaration({ key: 'other.party.add-note' }),
    moduleId: 'test',
    published: true,
  };
  expect(failureOf(projectPublishedCatalog([foreign])).code).toBe('access_changes_foreign_module_key');
});

it('refuses the same capability published twice', () => {
  const note = { key: 'test.party.add-note' };
  expect(failureOf(projectPublishedCatalog([published(note), published(note)])).code).toBe(
    'access_changes_duplicate_capability',
  );
});

it('refuses a catalog entry the model cannot classify', () => {
  const unclassified = {
    key: 'test.party.add-note',
    kind: 'nonsense',
    modes: ['run'],
    moduleKey: 'test',
    placement: { group: 'parties', level: 'basic' },
    risk: 'routine',
    selectors: [],
  };
  expect(failureOf(decodeCatalogEntry(unclassified)).code).toBe('access_changes_declaration_invalid');
});
