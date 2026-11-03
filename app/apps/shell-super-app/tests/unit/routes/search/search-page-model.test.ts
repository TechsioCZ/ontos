import { Schema } from 'effect';
import { expect, test } from 'effect-rstest';

import type { ShellSearchResult } from '../../../../shared/api.ts';
import { LegalEntityIdSchema, ModuleIdSchema, ResourceIdSchema, TenantIdSchema } from '../../../../shared/api.ts';
import { planShellSearchFilters } from '../../../../src/routes/[lang]/search/search-page-model.ts';

const tenantId = Schema.decodeUnknownSync(TenantIdSchema)('00000000-0000-4000-8000-000000000101');
const legalEntityId = Schema.decodeUnknownSync(LegalEntityIdSchema)('00000000-0000-4000-8000-000000000201');
let sequence = 0;

const hit = (moduleId: string, resourceType: string, title: string): ShellSearchResult => {
  sequence += 1;
  return {
    kind: 'resource',
    ref: {
      moduleId: Schema.decodeUnknownSync(ModuleIdSchema)(moduleId),
      resourceId: Schema.decodeUnknownSync(ResourceIdSchema)(`resource-${sequence}`),
      resourceType,
      tenantId,
    },
    selectedLegalEntityId: legalEntityId,
    title,
  };
};

const invoice = () => hit('finance.billing', 'finance.billing.invoice', 'Faktura');
const task = () => hit('work.tasks', 'work.tasks.task', 'Úkol');
const counterparty = () => hit('party.registry', 'party.registry.counterparty', 'Odběratel');
const crmClient = () => hit('demo.crm', 'demo.crm.client', 'Klient');
const unknownResource = () => hit('inventory.stock', 'inventory.stock.stock-item', 'Položka');

test('no selected family omits the resourceTypes field and names the observed families', () => {
  const plan = planShellSearchFilters({
    partial: false,
    requestedFamilies: [],
    results: [invoice(), task(), counterparty()],
  });
  expect(plan.selectedFamilies).toEqual([]);
  expect(plan.resourceTypes).toBeUndefined();
  expect(plan.availableFamilies.map(({ key }) => key)).toEqual(['companies', 'finance', 'work']);
  expect(plan.availableFamilies[0]?.groups).toEqual(['counterparty']);
});

test('a selected family sends only the exact observed admitted types', () => {
  const plan = planShellSearchFilters({
    partial: false,
    requestedFamilies: ['companies'],
    results: [counterparty(), crmClient()],
  });
  expect(plan.selectedFamilies).toEqual(['companies']);
  // The registry also knows crmClient; it is included only because this answer really observed it.
  expect(plan.resourceTypes).toEqual(['party.registry.counterparty', 'demo.crm.client']);
});

test('a type that is registered but not observed in this answer is not dispatched', () => {
  const plan = planShellSearchFilters({
    partial: false,
    requestedFamilies: ['companies'],
    results: [counterparty()],
  });
  expect(plan.selectedFamilies).toEqual(['companies']);
  expect(plan.resourceTypes).toEqual(['party.registry.counterparty']);
});

test('a new query drops a selection that no longer has an observed family', () => {
  const plan = planShellSearchFilters({
    partial: false,
    requestedFamilies: ['work'],
    results: [invoice()],
  });
  expect(plan.availableFamilies.map(({ key }) => key)).toEqual(['finance']);
  expect(plan.selectedFamilies).toEqual([]);
  expect(plan.resourceTypes).toBeUndefined();
});

test('a partial answer offers no filter and never guesses a payload', () => {
  const plan = planShellSearchFilters({
    partial: true,
    requestedFamilies: ['work'],
    results: [task()],
  });
  expect(plan).toEqual({ availableFamilies: [], selectedFamilies: [] });
});

test('the catch-all record family is not offered as a narrowing filter', () => {
  const plan = planShellSearchFilters({
    partial: false,
    requestedFamilies: ['other'],
    results: [unknownResource(), task()],
  });
  expect(plan.availableFamilies.map(({ key }) => key)).toEqual(['work']);
  expect(plan.selectedFamilies).toEqual([]);
  expect(plan.resourceTypes).toBeUndefined();
});

test('a selected family with several observed groups keeps the family order and all observed types', () => {
  const plan = planShellSearchFilters({
    partial: false,
    requestedFamilies: ['work', 'companies'],
    results: [task(), counterparty(), crmClient()],
  });
  expect(plan.selectedFamilies).toEqual(['companies', 'work']);
  expect(plan.resourceTypes).toEqual(['party.registry.counterparty', 'demo.crm.client', 'work.tasks.task']);
});
