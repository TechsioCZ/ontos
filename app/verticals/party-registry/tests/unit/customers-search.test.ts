import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CustomerListItemSchema } from '../../shared/apis/customer-list.ts';
import { PartyRefSchema } from '../../shared/resources/party.ts';
import { matchesCustomerSearch } from '../../src/routes/[lang]/prodej/zakaznici/customers-model.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '40000000-0000-4000-8000-000000000001';
const counterpartyId = '30000000-0000-4000-8000-000000000001';
const partyRef = Schema.decodeSync(PartyRefSchema)({
  moduleId: 'party.registry',
  resourceId: partyId,
  resourceType: 'party.registry.party',
  tenantId,
});

const customer = (displayName: string, city: string | null, phone: string | null = null) =>
  Schema.decodeSync(CustomerListItemSchema)({
    city,
    companyId: null,
    counterpartyId,
    counterpartyRef: {
      moduleId: 'party.registry',
      resourceId: counterpartyId,
      resourceType: 'party.registry.counterparty',
      tenantId,
    },
    createdAt: '2026-01-05T08:00:00.000Z',
    displayName,
    email: null,
    partyId,
    partyRef,
    partyRevision: 1,
    phone,
    status: 'ACTIVE',
    vatId: null,
  });

it('matches names and cities without diacritics in either direction', () => {
  const dvorak = customer('Petr Dvořák', 'Ústí nad Labem');
  expect(matchesCustomerSearch(dvorak, 'dvorak')).toBe(true);
  expect(matchesCustomerSearch(dvorak, 'dvořák')).toBe(true);
  expect(matchesCustomerSearch(dvorak, 'usti')).toBe(true);
  expect(matchesCustomerSearch(dvorak, 'ÚSTÍ')).toBe(true);
  expect(matchesCustomerSearch(dvorak, 'horak')).toBe(false);
});

it('treats an empty or blank query as a match for every customer', () => {
  const item = customer('Labská logistika a.s.', null);
  expect(matchesCustomerSearch(item, '')).toBe(true);
  expect(matchesCustomerSearch(item, '   ')).toBe(true);
});

it('finds a customer by phone digits whatever the grouping or country prefix', () => {
  const item = customer('Zahradní servis Malá s.r.o.', null, '+420 777 642 318');
  expect(matchesCustomerSearch(item, '777 642 318')).toBe(true);
  expect(matchesCustomerSearch(item, '777642318')).toBe(true);
  expect(matchesCustomerSearch(item, '+420777642318')).toBe(true);
  expect(matchesCustomerSearch(item, '00420 777 642 318')).toBe(true);
  expect(matchesCustomerSearch(item, '642 318')).toBe(true);
  expect(matchesCustomerSearch(item, '602 445')).toBe(false);
});
