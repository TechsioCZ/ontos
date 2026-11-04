import { Schema } from 'effect';
import { expect, test } from 'effect-rstest';

import type { ShellSearchResult } from '../../shared/api.ts';
import { LegalEntityIdSchema, ModuleIdSchema, ResourceIdSchema, TenantIdSchema } from '../../shared/api.ts';
import type { CoreSearchPresentationEntry } from '@app/core-runtime/search-contract';

import {
  MAXIMUM_SHELL_SEARCH_RESULT_BADGES,
  planShellSearchFilters,
  shellSearchFamiliesInOrder,
  shellSearchResultBadges,
  shellSearchResultKey,
  shellSearchTitleMatchRanges,
  shellSearchTitleSegments,
  toggleShellSearchFamily,
} from '../../src/routes/shell-search-match.ts';
import { shellSearchFamilies, shellSearchPresentationIndex } from '../../src/routes/shell-search-resource-types.ts';

const tenantId = Schema.decodeUnknownSync(TenantIdSchema)('00000000-0000-4000-8000-000000000101');
const legalEntityId = Schema.decodeUnknownSync(LegalEntityIdSchema)('00000000-0000-4000-8000-000000000201');
const moduleId = Schema.decodeUnknownSync(ModuleIdSchema)('party.registry');
let sequence = 0;

const resourceRef = (resourceType: string) => {
  sequence += 1;
  return {
    moduleId,
    resourceId: Schema.decodeUnknownSync(ResourceIdSchema)(
      `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    ),
    resourceType,
    tenantId,
  };
};

const resourceHit = (title: string): ShellSearchResult => ({
  kind: 'resource',
  ref: resourceRef('work.tasks.task'),
  selectedLegalEntityId: legalEntityId,
  title,
});

const partyOf = (title: string, archived: boolean, matchedViaAlias: boolean) => ({
  archived,
  matchedViaAlias,
  ref: resourceRef('party.registry.party'),
  title,
});

const partyHit = (title: string, archived = false, matchedViaAlias = false): ShellSearchResult => ({
  ...partyOf(title, archived, matchedViaAlias),
  kind: 'party',
});

const counterpartyHit = (
  title: string,
  options: { readonly archived?: boolean; readonly collision?: boolean; readonly matchedViaAlias?: boolean } = {},
): ShellSearchResult => {
  const party = partyOf(title, options.archived ?? false, options.matchedViaAlias ?? false);
  const hit: Extract<ShellSearchResult, { readonly kind: 'counterparty' }> = {
    currentRoles: ['CUSTOMER', 'SUPPLIER'],
    kind: 'counterparty',
    legalEntity: { legalEntityId, tenantId },
    party,
    ref: resourceRef('party.registry.counterparty'),
    title,
  };
  return options.collision === true
    ? {
        ...hit,
        collision: {
          counterpartyRefs: [party.ref, resourceRef('party.registry.counterparty')],
          kind: 'CANONICAL_PARTY_COUNTERPARTY_COLLISION',
        },
      }
    : hit;
};

/** A highlight must never rewrite the title: the runs always reassemble it character for character. */
const joined = (title: string, query: string) =>
  shellSearchTitleSegments(title, query)
    .map(({ text }) => text)
    .join('');

test('a Czech title matches a query typed without diacritics, and the whole title is highlighted', () => {
  expect(shellSearchTitleSegments('Řízek', 'rizek')).toEqual([{ matched: true, start: 0, text: 'Řízek' }]);
  expect(shellSearchTitleSegments('rizek', 'ŘÍZEK')).toEqual([{ matched: true, start: 0, text: 'rizek' }]);
});

test('only the matching part of a title is highlighted, in its own original characters', () => {
  expect(shellSearchTitleSegments('Řízek', 'Riz')).toEqual([
    { matched: true, start: 0, text: 'Říz' },
    { matched: false, start: 3, text: 'ek' },
  ]);
  expect(shellSearchTitleSegments('Řízek', 'zek')).toEqual([
    { matched: false, start: 0, text: 'Ří' },
    { matched: true, start: 2, text: 'zek' },
  ]);
});

test('a title written with combining marks highlights the same characters as the composed title', () => {
  const decomposed = 'Ři\u0301zek';
  expect(joined(decomposed, 'rizek')).toBe(decomposed);
  const segments = shellSearchTitleSegments(decomposed, 'rizek');
  expect(segments).toHaveLength(1);
  expect(segments[0]?.matched).toBe(true);
  expect(segments[0]?.text).toBe(decomposed);
});

test('a ligature match highlights its own character and does not shift the rest of the title', () => {
  expect(shellSearchTitleSegments('ﬁlozofie', 'filozofie')).toEqual([{ matched: true, start: 0, text: 'ﬁlozofie' }]);
  expect(shellSearchTitleSegments('ﬁlozofie', 'lozo')).toEqual([
    { matched: false, start: 0, text: 'ﬁ' },
    { matched: true, start: 1, text: 'lozo' },
    { matched: false, start: 5, text: 'fie' },
  ]);
  expect(joined('ﬁlozofie', 'lozo')).toBe('ﬁlozofie');
});

test('a terminal combining mark stays inside the highlighted grapheme', () => {
  const decomposed = 'i\u0301';
  expect(shellSearchTitleMatchRanges(decomposed, 'i')).toEqual([{ end: 2, start: 0 }]);
  expect(shellSearchTitleSegments(decomposed, 'i')).toEqual([{ matched: true, start: 0, text: decomposed }]);
  expect(shellSearchTitleSegments(`x${decomposed}`, 'i')).toEqual([
    { matched: false, start: 0, text: 'x' },
    { matched: true, start: 1, text: decomposed },
  ]);
  expect(joined(decomposed, 'i')).toBe(decomposed);
});

test('whole-string case folding matches a Greek final sigma', () => {
  expect(shellSearchTitleSegments('ΟΣ', 'ος')).toEqual([{ matched: true, start: 0, text: 'ΟΣ' }]);
  expect(shellSearchTitleSegments('ΟΣ', 'ΟΣ')).toEqual([{ matched: true, start: 0, text: 'ΟΣ' }]);
  expect(shellSearchTitleMatchRanges('ΟΣ', 'ος')).toEqual([{ end: 2, start: 0 }]);
  expect(joined('ΟΣ', 'ος')).toBe('ΟΣ');
});

test('overlapping occurrences merge into one highlighted run', () => {
  expect(shellSearchTitleMatchRanges('banana', 'ana')).toEqual([{ end: 6, start: 1 }]);
  expect(shellSearchTitleSegments('banana', 'ana')).toEqual([
    { matched: false, start: 0, text: 'b' },
    { matched: true, start: 1, text: 'anana' },
  ]);
  expect(joined('banana', 'ana')).toBe('banana');
});

test('supplementary characters keep their original UTF-16 offsets', () => {
  expect(shellSearchTitleMatchRanges('😀banana', 'ana')).toEqual([{ end: 8, start: 3 }]);
  expect(shellSearchTitleSegments('😀banana', 'ana')).toEqual([
    { matched: false, start: 0, text: '😀b' },
    { matched: true, start: 3, text: 'anana' },
  ]);
  expect(joined('😀banana', 'ana')).toBe('😀banana');
});

test('case folding that expands a character still highlights exactly that character', () => {
  expect(shellSearchTitleSegments('İstanbul', 'istanbul')).toEqual([{ matched: true, start: 0, text: 'İstanbul' }]);
});

test('an unmatched or empty query highlights nothing and keeps the title intact', () => {
  expect(shellSearchTitleSegments('Řízek', 'novak')).toEqual([{ matched: false, start: 0, text: 'Řízek' }]);
  expect(shellSearchTitleSegments('Řízek', '')).toEqual([{ matched: false, start: 0, text: 'Řízek' }]);
  expect(shellSearchTitleSegments('Řízek', '   ')).toEqual([{ matched: false, start: 0, text: 'Řízek' }]);
  expect(shellSearchTitleSegments('', 'rizek')).toEqual([]);
});

test('every word of a multi-word query is highlighted, and overlapping words merge into one run', () => {
  expect(shellSearchTitleMatchRanges('Řízek Praha', 'praha řízek')).toEqual([
    { end: 5, start: 0 },
    { end: 11, start: 6 },
  ]);
  expect(shellSearchTitleMatchRanges('Novák Novák', 'novak nov')).toEqual([
    { end: 5, start: 0 },
    { end: 11, start: 6 },
  ]);
});

test('a query with no usable tokens never scans the title', () => {
  expect(shellSearchTitleMatchRanges('Řízek', '\t \n')).toEqual([]);
});

test('a resource hit carries no badge, because the owner published no Party state for it', () => {
  expect(shellSearchResultBadges(resourceHit('Zavolat Novákovi'))).toEqual([]);
});

test('a plain Party hit carries no badge either; only real owner flags become badges', () => {
  expect(shellSearchResultBadges(partyHit('Jan Novák'))).toEqual([]);
  expect(shellSearchResultBadges(partyHit('Jan Novák', true))).toEqual([
    { key: 'archived', labelKey: 'shell.search.archived', tone: 'warning' },
  ]);
  expect(shellSearchResultBadges(partyHit('Jan Novák', false, true))).toEqual([
    { key: 'aliasMatch', labelKey: 'shell.search.alias_match', tone: 'info' },
  ]);
});

test('a row shows at most two badges, the ones that change what a person does next first', () => {
  const badges = shellSearchResultBadges(
    counterpartyHit('Jan Novák', { archived: true, collision: true, matchedViaAlias: true }),
  );
  expect(badges).toHaveLength(MAXIMUM_SHELL_SEARCH_RESULT_BADGES);
  expect(badges.map(({ key }) => key)).toEqual(['reconciliationRequired', 'archived']);
});

test('a counterparty keeps its role badges when nothing more urgent competes', () => {
  expect(shellSearchResultBadges(counterpartyHit('Jan Novák')).map(({ labelKey }) => labelKey)).toEqual([
    'shell.search.roles.CUSTOMER',
    'shell.search.roles.SUPPLIER',
  ]);
});

const compositionRevision = 'a'.repeat(64);
const label = (cs: string, en: string) => ({ cs, en });
const metadata = (key: string, order: number, cs: string, en: string) => ({
  icon: 'icon-[mdi--file-outline]' as const,
  key,
  label: label(cs, en),
  order,
});

const inventoryEntry = (
  ownerModuleId: string,
  resourceType: string,
  family: { readonly key: string; readonly order: number },
  group: { readonly key: string; readonly order: number },
): CoreSearchPresentationEntry => ({
  ownerModuleId,
  presentation: {
    family: metadata(family.key, family.order, family.key, family.key),
    group: metadata(group.key, group.order, group.key, group.key),
    scope: 'company',
  },
  resourceType,
  searchKey: `${ownerModuleId}.search`,
});

const inventory = () => {
  const index = shellSearchPresentationIndex(
    {
      business: {
        compositionRevision,
        entries: [
          inventoryEntry(
            'party.registry',
            'party.registry.counterparty',
            { key: 'companies', order: 10 },
            {
              key: 'counterparty',
              order: 20,
            },
          ),
          inventoryEntry(
            'demo.crm',
            'demo.crm.client',
            { key: 'companies', order: 10 },
            {
              key: 'client',
              order: 10,
            },
          ),
          inventoryEntry(
            'finance.billing',
            'finance.billing.invoice',
            { key: 'finance', order: 30 },
            {
              key: 'invoice',
              order: 30,
            },
          ),
        ],
        schemaVersion: '1',
      },
      pages: [],
    },
    compositionRevision,
  );
  if (index === undefined) {
    throw new Error('expected a current validated inventory');
  }
  return index;
};

test('no selected family omits the resourceTypes field and names the declared families in owner order', () => {
  const plan = planShellSearchFilters({ index: inventory(), partial: false, requestedFamilies: [] });
  expect(plan.selectedFamilies).toEqual([]);
  expect(plan.resourceTypes).toBeUndefined();
  expect(plan.availableFamilies.map(({ key }) => key)).toEqual(['companies', 'finance']);
  expect(plan.availableFamilies[0]?.family.groups.map(({ key }) => key)).toEqual(['client', 'counterparty']);
});

test('a selected family asks the server for exactly its declared resource types', () => {
  const plan = planShellSearchFilters({ index: inventory(), partial: false, requestedFamilies: ['finance'] });
  expect(plan.selectedFamilies).toEqual(['finance']);
  expect(plan.resourceTypes).toEqual(['finance.billing.invoice']);
  const companies = planShellSearchFilters({ index: inventory(), partial: false, requestedFamilies: ['companies'] });
  expect(companies.resourceTypes).toEqual(['demo.crm.client', 'party.registry.counterparty']);
});

test('an unknown or unresolved family never broadens the request to every type', () => {
  expect(planShellSearchFilters({ index: inventory(), partial: false, requestedFamilies: ['missing'] })).toMatchObject({
    resourceTypes: [],
    selectedFamilies: [],
  });
  expect(
    planShellSearchFilters({ index: inventory(), partial: false, requestedFamilies: ['finance', 'missing'] }),
  ).toMatchObject({ resourceTypes: [], selectedFamilies: ['finance'] });
});

test('without a validated inventory no family filter can be resolved', () => {
  const noInventory = shellSearchPresentationIndex(undefined, compositionRevision);
  const plan = planShellSearchFilters({ index: noInventory, partial: false, requestedFamilies: ['companies'] });
  expect(plan).toEqual({ availableFamilies: [], resourceTypes: [], selectedFamilies: [] });
});

test('a partial answer offers no filter and never guesses a payload', () => {
  const plan = planShellSearchFilters({ index: inventory(), partial: true, requestedFamilies: ['finance'] });
  expect(plan).toEqual({ availableFamilies: [], selectedFamilies: [] });
});

test('family order comes from the validated inventory, not from the request or a shell taxonomy', () => {
  const families = shellSearchFamilies(inventory());
  expect(families.map(({ key }) => key)).toEqual(['companies', 'finance']);
  expect(shellSearchFamiliesInOrder(['finance', 'companies', 'unknown'], families)).toEqual(['companies', 'finance']);
});

test('toggling a family adds it once and removes it again', () => {
  const once = toggleShellSearchFamily([], 'finance');
  expect(once).toEqual(['finance']);
  expect(toggleShellSearchFamily(once, 'finance')).toEqual([]);
  expect(toggleShellSearchFamily(['finance'], 'people')).toEqual(['finance', 'people']);
});

test('a hit is identified by its owner ref, so one record is one row', () => {
  expect(shellSearchResultKey(counterpartyHit('Jan Novák'))).toMatch(
    /^party\.registry:party\.registry\.counterparty:/u,
  );
  expect(shellSearchResultKey(partyHit('Jan Novák'))).toMatch(/^party\.registry:party\.registry\.party:/u);
});
