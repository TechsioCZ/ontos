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
  const product = resourceHit('demo.merchandise', 'demo.merchandise.product', 'Kotel K-200');
  expect(shellSearchResultTarget(product)).toEqual({
    params: { id: product.ref.resourceId },
    to: '/provoz/produkty/$id',
  });
  const market = resourceHit('commerce.market-catalog', 'commerce.market-catalog.market', 'Slovensko');
  expect(shellSearchResultTarget(market)).toEqual({
    params: { id: market.ref.resourceId },
    to: '/prodej/eshopy/trhy/$id',
  });
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
  const hit = resourceHit('facility.operations', 'facility.operations.asset', 'Plynová kotelna', resourceId);
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

test('a merchandise order opens the orders agenda with the order selected', () => {
  const order = resourceHit('demo.merchandise', 'demo.merchandise.order', 'Objednávka Novák');
  expect(shellSearchResultTarget(order)).toEqual({
    search: { orderId: order.ref.resourceId },
    to: '/prodej/objednavky',
  });
});

test.each([
  ['core.identity', 'core.identity.person', 'Jana Nováková', '/sprava/lide-a-role'],
  ['demo.crm', 'demo.crm.contact', 'Petr Svoboda', '/crm/klienti'],
  ['finance.billing', 'finance.billing.document', 'Dobropis 7', '/finance'],
] as const)(
  '%s %s without a record page opens the Shell record page and names only its agenda',
  (moduleId, resourceType, title, agenda) => {
    const hit = resourceHit(moduleId, resourceType, title);
    expect(ownerRecordTarget(hit.ref, selectedLegalEntityId)).toBeUndefined();
    expect(shellSearchResultTarget(hit)).toMatchObject({
      to: '/resources/$moduleId/$resourceType/$resourceId',
    });
    expect(recordAgendaPaths(hit.ref)).toEqual([agenda]);
  },
);

test('a type without named agendas, or a forged owner, falls back to the owning module agendas', () => {
  expect(recordAgendaPaths(resourceHit('work.tasks', 'work.tasks.task', 'Úkol').ref)).toBeUndefined();
  expect(recordAgendaPaths(resourceHit('demo.crm', 'core.identity.person', 'Podvržená osoba').ref)).toBeUndefined();
});

test('records without an owner page open the Shell record page carrying only the found title', () => {
  const opportunity = resourceHit('demo.sales-pipeline', 'demo.sales-pipeline.opportunity', 'Serverovna');
  expect(ownerRecordTarget(opportunity.ref, selectedLegalEntityId)).toBeUndefined();
  const target = shellSearchResultTarget(opportunity);
  expect(target).toMatchObject({
    params: {
      moduleId: 'demo.sales-pipeline',
      resourceId: opportunity.ref.resourceId,
      resourceType: 'demo.sales-pipeline.opportunity',
    },
    to: '/resources/$moduleId/$resourceType/$resourceId',
  });
  expect('state' in target ? target.state({ __TSR_key: 'k' }) : undefined).toEqual({
    __TSR_key: 'k',
    searchHitTitle: 'Serverovna',
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
