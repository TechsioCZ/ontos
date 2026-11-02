import { Schema } from 'effect';
import { expect, test } from 'effect-rstest';

import { LegalEntityIdSchema, ModuleIdSchema, ResourceIdSchema, TenantIdSchema } from '../../shared/api.ts';
import type { ShellSearchResult } from '../../shared/api.ts';
import {
  ownerRecordTarget,
  shellSearchGroupOf,
  shellSearchLinkTarget,
} from '../../src/routes/shell-search-resource-types.ts';
import { groupShellSearchResults, groupShellSearchSuggestions } from '../../src/routes/shell-search-suggestions.ts';

const tenantId = Schema.decodeUnknownSync(TenantIdSchema)('00000000-0000-4000-8000-000000000101');
const selectedLegalEntityId = Schema.decodeUnknownSync(LegalEntityIdSchema)('00000000-0000-4000-8000-000000000201');
let sequence = 0;

/** A generic owner hit as the Shell receives it: owner ref, human title and the trusted selected company. */
const resourceHit = (moduleId: string, resourceType: string, title: string): ShellSearchResult => {
  sequence += 1;
  const hit = {
    kind: 'resource' as const,
    ref: {
      moduleId: Schema.decodeUnknownSync(ModuleIdSchema)(moduleId),
      resourceId: Schema.decodeUnknownSync(ResourceIdSchema)(
        `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
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
  expect(shellSearchLinkTarget(invoice.ref, invoice.title)).toEqual({
    search: { resourceId: invoice.ref.resourceId },
    to: '/finance',
  });
  const client = resourceHit('demo.crm', 'demo.crm.client', 'Strojírny Vysočina');
  expect(shellSearchLinkTarget(client.ref, client.title)).toEqual({
    search: { klient: client.ref.resourceId },
    to: '/crm/klienti',
  });
  const product = resourceHit('demo.merchandise', 'demo.merchandise.product', 'Kotel K-200');
  expect(shellSearchLinkTarget(product.ref, product.title)).toEqual({
    params: { id: product.ref.resourceId },
    to: '/provoz/produkty/$id',
  });
  const market = resourceHit('commerce.market-catalog', 'commerce.market-catalog.market', 'Slovensko');
  expect(shellSearchLinkTarget(market.ref, market.title)).toEqual({
    params: { id: market.ref.resourceId },
    to: '/prodej/eshopy/trhy/$id',
  });
});

test('records without an owner page open the Shell record page carrying only the found title', () => {
  const opportunity = resourceHit('demo.sales-pipeline', 'demo.sales-pipeline.opportunity', 'Serverovna');
  expect(ownerRecordTarget(opportunity.ref)).toBeUndefined();
  const target = shellSearchLinkTarget(opportunity.ref, opportunity.title);
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
  expect(ownerRecordTarget(forged.ref)).toBeUndefined();
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
