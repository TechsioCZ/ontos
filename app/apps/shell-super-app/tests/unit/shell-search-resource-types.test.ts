import { Schema } from 'effect';
import { expect, test } from 'effect-rstest';

import { LegalEntityIdSchema, ModuleIdSchema, ResourceIdSchema, TenantIdSchema } from '../../shared/api.ts';
import type { ShellSearchResult } from '../../shared/api.ts';
import {
  ownerRecordTarget as ownerRecordTargetOf,
  recordAgendaPaths as recordAgendaPathsOf,
  shellSearchGroupOf as shellSearchGroupOfOf,
  shellSearchLinkTarget as shellSearchLinkTargetOf,
  shellSearchPresentationContext,
  shellSearchResultTarget as shellSearchResultTargetOf,
} from '../../src/routes/shell-search-resource-types.ts';
import {
  groupShellSearchResults as groupShellSearchResultsOf,
  groupShellSearchSuggestions as groupShellSearchSuggestionsOf,
} from '../../src/routes/shell-search-suggestions.ts';

/**
 * The composed navigation the Shell receives for the demo document: it names every destination a record type opens,
 * the section that settles names several owners share, and no destination a record type does not open.
 */
const presentation = shellSearchPresentationContext([
  { groupKey: 'shell.navigation.finance', href: '/finance', moduleId: 'finance.billing' },
  { groupKey: 'shell.navigation.sales', href: '/crm/klienti', moduleId: 'demo.crm' },
  { groupKey: 'shell.navigation.sales', href: '/prodej/zakaznici', moduleId: 'party.registry' },
  { groupKey: 'shell.navigation.sales', href: '/prodej/prilezitosti', moduleId: 'demo.sales-pipeline' },
  { groupKey: 'shell.navigation.sales', href: '/smlouvy', moduleId: 'legal.agreements' },
  { groupKey: 'shell.navigation.commerce', href: '/prodej/objednavky', moduleId: 'demo.merchandise' },
  { groupKey: 'shell.navigation.commerce', href: '/provoz/produkty', moduleId: 'demo.merchandise' },
  { groupKey: 'shell.navigation.commerce', href: '/prodej/eshopy', moduleId: 'commerce.market-catalog' },
  { groupKey: 'shell.navigation.team', href: '/ukoly', moduleId: 'work.tasks' },
  { groupKey: 'shell.navigation.real-estate', href: '/nemovitosti', moduleId: 'property.portfolio' },
  { groupKey: 'shell.navigation.real-estate', href: '/najmy', moduleId: 'property.leasing' },
  { groupKey: 'shell.navigation.facility', href: '/provoz/majetek', moduleId: 'facility.operations' },
  { groupKey: 'shell.navigation.facility', href: '/provoz/bezpecnost', moduleId: 'facility.operations' },
  { groupKey: 'shell.navigation.facility', href: '/provoz/meridla', moduleId: 'facility.operations' },
  { groupKey: 'shell.navigation.facility', href: '/provoz/dokumenty', moduleId: 'facility.operations' },
]);

const ownerRecordTarget = (ref: Parameters<typeof ownerRecordTargetOf>[0], company: string | undefined) =>
  ownerRecordTargetOf(ref, company, presentation);
const recordAgendaPaths = (ref: Parameters<typeof recordAgendaPathsOf>[0]) => recordAgendaPathsOf(ref, presentation);
const shellSearchGroupOf = (result: Parameters<typeof shellSearchGroupOfOf>[0]) =>
  shellSearchGroupOfOf(result, presentation);
const shellSearchLinkTarget = (
  ref: Parameters<typeof shellSearchLinkTargetOf>[0],
  title: string,
  company: string | undefined,
) => shellSearchLinkTargetOf(ref, title, company, presentation);
const shellSearchResultTarget = (result: Parameters<typeof shellSearchResultTargetOf>[0]) =>
  shellSearchResultTargetOf(result, presentation);
const groupShellSearchResults = (results: Parameters<typeof groupShellSearchResultsOf>[0]) =>
  groupShellSearchResultsOf(results, presentation);
const groupShellSearchSuggestions = (results: Parameters<typeof groupShellSearchSuggestionsOf>[0], perGroup: number) =>
  groupShellSearchSuggestionsOf(results, perGroup, presentation);

const tenantId = Schema.decodeUnknownSync(TenantIdSchema)('00000000-0000-4000-8000-000000000101');
const selectedLegalEntityId = Schema.decodeUnknownSync(LegalEntityIdSchema)('00000000-0000-4000-8000-000000000201');
let sequence = 0;

/** A generic owner hit as the Shell receives it: owner ref, human title and the trusted selected company. */
const resourceHit = (moduleId: string, resourceType: string, title: string, resourceId?: string): ShellSearchResult => {
  sequence += 1;
  const hit = {
    kind: 'resource' as const,
    ref: {
      moduleId: Schema.decodeUnknownSync(ModuleIdSchema)(moduleId),
      resourceId: Schema.decodeUnknownSync(ResourceIdSchema)(
        resourceId ?? `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
      ),
      resourceType,
      tenantId,
    },
    selectedLegalEntityId,
    title,
  };
  return hit;
};

const partyRef = {
  moduleId: Schema.decodeUnknownSync(ModuleIdSchema)('party.registry'),
  resourceId: Schema.decodeUnknownSync(ResourceIdSchema)('00000000-0000-4000-8000-000000000901'),
  resourceType: 'party.registry.party',
  tenantId,
};

const evaCounterpartyId = Schema.decodeUnknownSync(ResourceIdSchema)('ea2200ab-4308-491e-8e33-ca3871a8fa55');

test('Eva Bílá opens her exact counterparty page, never a page selected by the distinct Party identity', () => {
  const hit = {
    currentRoles: ['CUSTOMER'],
    kind: 'counterparty',
    legalEntity: { legalEntityId: selectedLegalEntityId, tenantId },
    party: { archived: false, matchedViaAlias: true, ref: partyRef, title: 'Eva Bílá' },
    ref: { ...partyRef, resourceId: evaCounterpartyId, resourceType: 'party.registry.counterparty' },
    title: 'Eva Bílá',
  } satisfies ShellSearchResult;
  expect(shellSearchResultTarget(hit)).toEqual({
    params: { id: evaCounterpartyId },
    to: '/prodej/zakaznici/$id',
  });
  // The Party identity page is not a destination of the party owner's composed navigation, so the Shell cannot prove
  // it and opens its own record page instead of naming an owner route the composition never declared.
  expect(ownerRecordTarget(partyRef, selectedLegalEntityId)).toBeUndefined();
  expect(
    shellSearchResultTarget({
      archived: false,
      kind: 'party',
      matchedViaAlias: false,
      ref: partyRef,
      title: 'Eva Bílá',
    }),
  ).toMatchObject({
    params: { moduleId: 'party.registry', resourceId: partyRef.resourceId, resourceType: 'party.registry.party' },
    to: '/resources/$moduleId/$resourceType/$resourceId',
  });
  // Alias and archive state never replace a current owner ID with its Party ID or an old identity.
  expect(shellSearchResultTarget({ ...hit, party: { ...hit.party, archived: true } })).toEqual(
    shellSearchResultTarget(hit),
  );
});

test.each(['', 'not-a-uuid', `${selectedLegalEntityId}.${evaCounterpartyId}`, `${evaCounterpartyId}/other`])(
  'a malformed counterparty ID %s never becomes a customer page',
  (resourceId) => {
    expect(
      ownerRecordTarget(
        { moduleId: 'party.registry', resourceId, resourceType: 'party.registry.counterparty' },
        selectedLegalEntityId,
      ),
    ).toBeUndefined();
  },
);

test('another module cannot claim the counterparty owner route', () => {
  expect(
    ownerRecordTarget(
      { moduleId: 'demo.crm', resourceId: evaCounterpartyId, resourceType: 'party.registry.counterparty' },
      selectedLegalEntityId,
    ),
  ).toBeUndefined();
});

const covered = [
  ['facility.operations', 'facility.operations.asset', 'asset'],
  ['facility.operations', 'facility.operations.device', 'device'],
  ['facility.operations', 'facility.operations.document', 'facilityDocument'],
  ['core.identity', 'core.identity.person', 'person'],
  ['demo.crm', 'demo.crm.contact', 'crmContact'],
  ['demo.merchandise', 'demo.merchandise.order', 'order'],
  ['finance.billing', 'finance.billing.document', 'financeDocument'],
  ['demo.crm', 'demo.crm.client', 'crmClient'],
  ['demo.sales-pipeline', 'demo.sales-pipeline.opportunity', 'opportunity'],
  ['demo.merchandise', 'demo.merchandise.product', 'product'],
  ['work.tasks', 'work.tasks.task', 'task'],
  ['finance.billing', 'finance.billing.invoice', 'invoice'],
  ['legal.agreements', 'legal.agreements.contract', 'contract'],
  ['legal.agreements', 'legal.agreements.document', 'legalDocument'],
  ['property.portfolio', 'property.portfolio.property', 'property'],
  ['property.portfolio', 'property.portfolio.unit', 'unit'],
  ['property.portfolio', 'property.portfolio.asset', 'asset'],
  ['property.leasing', 'property.leasing.occupancy', 'lease'],
  ['commerce.market-catalog', 'commerce.market-catalog.market', 'market'],
] as const;

test.each(covered)('%s %s results form the %s group', (moduleId, resourceType, group) => {
  expect(shellSearchGroupOf(resourceHit(moduleId, resourceType, 'Záznam'))).toBe(group);
});

test('a type the Shell does not know yet, or one claimed by another module, stays under other records', () => {
  expect(shellSearchGroupOf(resourceHit('inventory.stock', 'commerce.inventory.stock-item', 'Sklad'))).toBe('resource');
  expect(shellSearchGroupOf(resourceHit('demo.crm', 'finance.billing.invoice', 'Podvržená faktura'))).toBe('resource');
});

/** The Shell record page: the only target a hit whose owner and destination the composition cannot prove may open. */
const expectNoOwnerTarget = (hit: ShellSearchResult) => {
  expect(ownerRecordTarget(hit.ref, selectedLegalEntityId)).toBeUndefined();
  expect(shellSearchResultTarget(hit)).toMatchObject({
    params: { moduleId: hit.ref.moduleId, resourceId: hit.ref.resourceId, resourceType: hit.ref.resourceType },
    to: '/resources/$moduleId/$resourceType/$resourceId',
  });
};

test.each(['unknown.owner.product', 'unknown.owner.invoice', 'unknown.owner.counterparty', 'unknown.owner.client'])(
  'a self-consistent owner outside this document (%s) never selects an owner route',
  (resourceType) => {
    const hit = resourceHit('unknown.owner', resourceType, 'Podvržený záznam');
    expect(shellSearchGroupOf(hit)).toBe('resource');
    expectNoOwnerTarget(hit);
  },
);

test.each([
  ['demo.crm', 'demo.crm.product'],
  ['demo.crm', 'demo.crm.invoice'],
  ['demo.crm', 'demo.crm.counterparty'],
  ['demo.crm', 'demo.crm.party'],
  ['finance.billing', 'finance.billing.product'],
  ['work.tasks', 'work.tasks.invoice'],
  ['facility.operations', 'facility.operations.invoice'],
] as const)(
  'a namespace-consistent owner %s that does not declare the destination of %s never claims it',
  (moduleId, resourceType) => {
    const hit = resourceHit(moduleId, resourceType, 'Podvržený záznam');
    expect(shellSearchGroupOf(hit)).toBe('resource');
    expectNoOwnerTarget(hit);
  },
);

test('an ambiguous owner navigation never picks a page for a record type', () => {
  const ambiguous = shellSearchPresentationContext([
    { groupKey: 'shell.navigation.sales', href: '/crm/klienti', moduleId: 'demo.crm' },
    { groupKey: 'shell.navigation.sales', href: '/crm/archiv/klienti', moduleId: 'demo.crm' },
  ]);
  const client = resourceHit('demo.crm', 'demo.crm.client', 'Strojírny Vysočina');
  expect(shellSearchGroupOfOf(client, ambiguous)).toBe('resource');
  expect(shellSearchResultTargetOf(client, ambiguous)).toMatchObject({
    to: '/resources/$moduleId/$resourceType/$resourceId',
  });
});

test('a same-suffix destination of another section never becomes the client agenda', () => {
  const misleading = shellSearchPresentationContext([
    { groupKey: 'shell.navigation.finance', href: '/finance/klienti', moduleId: 'finance.billing' },
  ]);
  const forged = resourceHit('finance.billing', 'finance.billing.client', 'Podvržený klient');
  expect(shellSearchGroupOfOf(forged, misleading)).toBe('resource');
  expect(shellSearchResultTargetOf(forged, misleading)).toMatchObject({
    to: '/resources/$moduleId/$resourceType/$resourceId',
  });
});

test('a document without a composition places every hit under other records', () => {
  const client = resourceHit('demo.crm', 'demo.crm.client', 'Strojírny Vysočina');
  expect(shellSearchGroupOfOf(client)).toBe('resource');
  expect(shellSearchResultTargetOf(client)).toMatchObject({ to: '/resources/$moduleId/$resourceType/$resourceId' });
});

test('a record type name shared by several owners is settled by the composed navigation section', () => {
  const finance = resourceHit('finance.billing', 'finance.billing.document', 'Doklad');
  const legal = resourceHit('legal.agreements', 'legal.agreements.document', 'Předávací protokol');
  const facility = resourceHit('facility.operations', 'facility.operations.document', 'Revize');
  expect([shellSearchGroupOf(finance), shellSearchGroupOf(legal), shellSearchGroupOf(facility)]).toEqual([
    'financeDocument',
    'legalDocument',
    'facilityDocument',
  ]);
  // Without the document's composed navigation the Shell cannot place a shared name; it stays under other records.
  expect(shellSearchGroupOfOf(finance)).toBe('resource');
});

test('an owner agenda resolved from navigation replaces a repeated owner route', () => {
  const client = resourceHit('demo.crm', 'demo.crm.client', 'Strojírny Vysočina');
  expect(shellSearchResultTarget(client)).toEqual({
    search: { klient: client.ref.resourceId },
    to: '/crm/klienti',
  });
  // A row without the document's navigation falls back to the Shell record page; that page redirects to the owner.
  expect(shellSearchResultTargetOf(client)).toMatchObject({ to: '/resources/$moduleId/$resourceType/$resourceId' });
});

test('records with an owner page open there, by path segment or query parameter', () => {
  const invoice = resourceHit('finance.billing', 'finance.billing.invoice', 'Faktura 2026/14');
  expect(shellSearchResultTarget(invoice)).toEqual({
    search: { resourceId: invoice.ref.resourceId },
    to: '/finance',
  });
  const client = resourceHit('demo.crm', 'demo.crm.client', 'Strojírny Vysočina');
  expect(shellSearchResultTarget(client)).toEqual({
    search: { klient: client.ref.resourceId },
    to: '/crm/klienti',
  });
  const opportunity = resourceHit('demo.sales-pipeline', 'demo.sales-pipeline.opportunity', 'Serverovna');
  expect(shellSearchResultTarget(opportunity)).toEqual({
    search: { opportunityId: opportunity.ref.resourceId },
    to: '/prodej/prilezitosti',
  });
  const market = resourceHit('commerce.market-catalog', 'commerce.market-catalog.market', 'Slovensko');
  expect(shellSearchResultTarget(market)).toEqual({
    params: { id: market.ref.resourceId },
    to: '/prodej/eshopy/trhy/$id',
  });
});

test.each([
  ['work.tasks', 'work.tasks.task', '/ukoly', 'resourceId'],
  ['legal.agreements', 'legal.agreements.contract', '/smlouvy', 'resourceId'],
  ['property.portfolio', 'property.portfolio.property', '/nemovitosti', 'resourceId'],
  ['property.portfolio', 'property.portfolio.unit', '/nemovitosti', 'resourceId'],
  ['property.portfolio', 'property.portfolio.asset', '/nemovitosti', 'resourceId'],
  ['property.leasing', 'property.leasing.occupancy', '/najmy', 'resourceId'],
] as const)('%s %s keeps the exact ID consumed by %s', (moduleId, resourceType, to, param) => {
  const hit = resourceHit(moduleId, resourceType, 'Vlastní záznam');
  expect(shellSearchResultTarget(hit)).toEqual({ search: { [param]: hit.ref.resourceId }, to });
});

const otherCompany = '00000000-0000-4000-8000-000000000299';

test.each([
  ['facility.operations.asset', '/provoz/majetek', 'asset'],
  ['facility.operations.device', '/provoz/bezpecnost', 'device'],
  ['facility.operations.document', '/provoz/dokumenty', 'doc'],
] as const)('%s of the selected company opens %s with its local ID', (resourceType, to, param) => {
  const hit = resourceHit('facility.operations', resourceType, 'Plynová kotelna', `${selectedLegalEntityId}.TEC-001`);
  expect(shellSearchResultTarget(hit)).toEqual({ search: { [param]: 'TEC-001' }, to });
  expect(recordAgendaPaths(hit.ref)).toEqual([to]);
});

test.each([
  ['another company', `${otherCompany}.TEC-001`, selectedLegalEntityId],
  ['no company on the result', `${selectedLegalEntityId}.TEC-001`, undefined],
  ['an unqualified ID', 'TEC-001', selectedLegalEntityId],
  ['a company prefix without the separator', `${selectedLegalEntityId}TEC-001`, selectedLegalEntityId],
  ['an empty local ID', `${selectedLegalEntityId}.`, selectedLegalEntityId],
] as const)('a facility record qualified with %s never opens an owner page', (_case, resourceId, company) => {
  const valid = resourceHit('facility.operations', 'facility.operations.asset', 'Plynová kotelna');
  const hit = { ...valid, ref: { ...valid.ref, resourceId } };
  expect(ownerRecordTarget(hit.ref, company)).toBeUndefined();
  const target = shellSearchLinkTarget(hit.ref, hit.title, company);
  expect(target).toMatchObject({ to: '/resources/$moduleId/$resourceType/$resourceId' });
  // The fallback opens the Shell record page named by the found title; no ID reaches the visible text.
  expect('state' in target ? target.state({}) : undefined).toEqual({ searchHitTitle: 'Plynová kotelna' });
});

test('native-ID records ignore the company and keep the resource ID as is', () => {
  const invoice = resourceHit('finance.billing', 'finance.billing.invoice', 'Faktura 2026/14');
  expect(ownerRecordTarget(invoice.ref, otherCompany)).toEqual({
    search: { resourceId: invoice.ref.resourceId },
    to: '/finance',
  });
});

const nativeProductId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

test('a merchandise product or order of the selected company opens with its native ID', () => {
  const product = resourceHit(
    'demo.merchandise',
    'demo.merchandise.product',
    'Kotel K-200',
    `${selectedLegalEntityId}.${nativeProductId}`,
  );
  expect(shellSearchResultTarget(product)).toEqual({ params: { id: nativeProductId }, to: '/provoz/produkty/$id' });
  const order = resourceHit(
    'demo.merchandise',
    'demo.merchandise.order',
    'Objednávka Novák',
    `${selectedLegalEntityId}.OBJ-2026-0042`,
  );
  expect(shellSearchResultTarget(order)).toEqual({ search: { orderId: 'OBJ-2026-0042' }, to: '/prodej/objednavky' });
});

test.each([
  ['demo.merchandise.product', 'another company', `${otherCompany}.${nativeProductId}`, selectedLegalEntityId],
  ['demo.merchandise.product', 'an unqualified ID', nativeProductId, selectedLegalEntityId],
  ['demo.merchandise.order', 'no company on the result', `${selectedLegalEntityId}.OBJ-1`, undefined],
  ['demo.merchandise.order', 'an empty native ID', `${selectedLegalEntityId}.`, selectedLegalEntityId],
] as const)('%s qualified with %s falls back to the Shell record page', (resourceType, _case, resourceId, company) => {
  const valid = resourceHit('demo.merchandise', resourceType, 'Kotel K-200');
  const hit = { ...valid, ref: { ...valid.ref, resourceId } };
  expect(ownerRecordTarget(hit.ref, company)).toBeUndefined();
  const target = shellSearchLinkTarget(hit.ref, hit.title, company);
  expect(target).toMatchObject({ to: '/resources/$moduleId/$resourceType/$resourceId' });
  expect('state' in target ? target.state({}) : undefined).toEqual({ searchHitTitle: 'Kotel K-200' });
});

test.each([
  ['demo.crm', 'demo.crm.contact', '/crm/klienti', 'osoba'],
  ['finance.billing', 'finance.billing.document', '/finance', 'documentId'],
] as const)(
  '%s %s opens its exact owner record without substituting another record type',
  (moduleId, type, to, key) => {
    const hit = resourceHit(moduleId, type, 'Detail záznamu');
    expect(shellSearchResultTarget(hit)).toEqual({ search: { [key]: hit.ref.resourceId }, to });
  },
);

test('a person link retains its full company-qualified identity for the governed directory to validate', () => {
  const id = `${selectedLegalEntityId}.00000000-0000-4000-8000-000000000901`;
  const hit = resourceHit('core.identity', 'core.identity.person', 'Jana Nováková', id);
  expect(shellSearchResultTarget(hit)).toEqual({ search: { person: id }, to: '/sprava/lide-a-role' });
});

test('a type without named agendas, or a forged owner, falls back to the owning module agendas', () => {
  expect(recordAgendaPaths(resourceHit('work.tasks', 'work.tasks.task', 'Úkol').ref)).toBeUndefined();
  expect(recordAgendaPaths(resourceHit('demo.crm', 'core.identity.person', 'Podvržená osoba').ref)).toBeUndefined();
});

test('records without an owner page open the Shell record page carrying only the found title', () => {
  const document = resourceHit('legal.agreements', 'legal.agreements.document', 'Předávací protokol');
  expect(ownerRecordTarget(document.ref, selectedLegalEntityId)).toBeUndefined();
  const target = shellSearchResultTarget(document);
  expect(target).toMatchObject({
    params: {
      moduleId: 'legal.agreements',
      resourceId: document.ref.resourceId,
      resourceType: 'legal.agreements.document',
    },
    to: '/resources/$moduleId/$resourceType/$resourceId',
  });
  expect('state' in target ? target.state({ __TSR_key: 'k' }) : undefined).toEqual({
    __TSR_key: 'k',
    searchHitTitle: 'Předávací protokol',
  });
  const forged = resourceHit('demo.crm', 'finance.billing.invoice', 'Podvržená faktura');
  expect(ownerRecordTarget(forged.ref, selectedLegalEntityId)).toBeUndefined();
});

test('groups follow the fixed order and keep the search order inside each group', () => {
  const results = [
    resourceHit('work.tasks', 'work.tasks.task', 'Zavolat Novákovi'),
    resourceHit('finance.billing', 'finance.billing.invoice', 'Faktura Novák'),
    resourceHit('inventory.stock', 'commerce.inventory.stock-item', 'Novák sklad'),
    resourceHit('work.tasks', 'work.tasks.task', 'Novák – revize'),
    {
      currentRoles: ['CUSTOMER' as const],
      kind: 'counterparty',
      legalEntity: { legalEntityId: selectedLegalEntityId, tenantId },
      party: { archived: false, matchedViaAlias: false, ref: partyRef, title: 'Jan Novák' },
      ref: { ...partyRef, resourceType: 'party.registry.counterparty' },
      title: 'Jan Novák',
    },
    { archived: false, kind: 'party', matchedViaAlias: false, ref: partyRef, title: 'Jan Novák' },
  ] satisfies readonly ShellSearchResult[];

  const groups = groupShellSearchResults(results);
  expect(groups.map(({ key }) => key)).toEqual(['counterparty', 'task', 'invoice', 'resource']);
  expect(groups.find(({ key }) => key === 'task')?.items.map(({ title }) => title)).toEqual([
    'Zavolat Novákovi',
    'Novák – revize',
  ]);

  const suggestions = groupShellSearchSuggestions(results, 1);
  const tasks = suggestions.find(({ key }) => key === 'task');
  expect(tasks?.total).toBe(2);
  expect(tasks?.suggestions.map(({ title }) => title)).toEqual(['Zavolat Novákovi']);
  expect(tasks?.suggestions[0]?.target).toMatchObject({ to: '/ukoly' });
});
