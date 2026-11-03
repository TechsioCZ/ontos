import { Schema } from 'effect';
import { expect, test } from 'effect-rstest';

import { LegalEntityIdSchema, ModuleIdSchema, ResourceIdSchema, TenantIdSchema } from '../../shared/api.ts';
import type { ShellSearchResult } from '../../shared/api.ts';
import {
  ownerRecordTarget,
  recordAgendaPaths,
  shellSearchGroupOf,
  shellSearchLinkTarget,
  shellSearchResultTarget,
} from '../../src/routes/shell-search-resource-types.ts';
import { groupShellSearchResults, groupShellSearchSuggestions } from '../../src/routes/shell-search-suggestions.ts';

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
  expect(ownerRecordTarget(partyRef, selectedLegalEntityId)).toEqual({
    params: { id: partyRef.resourceId },
    to: '/prodej/strany/$id',
  });
  expect(
    shellSearchResultTarget({
      archived: false,
      kind: 'party',
      matchedViaAlias: false,
      ref: partyRef,
      title: 'Eva Bílá',
    }),
  ).toEqual({ params: { id: partyRef.resourceId }, to: '/prodej/strany/$id' });
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
