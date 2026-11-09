import {
  customerSegmentDefinitions,
  SalesDemoCustomerFixtureSchema,
} from '@app/shared-contracts/demo/sales-customer-fixtures';
import { DateTime, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { v5 } from 'uuid';

import {
  salesDemoOrganizationIdentityFacts,
  salesDemoOrganizationParty,
  salesDemoSeedIds,
} from '../../scripts/reset-demo.mts';

const namespace = '00000000-0000-4000-8000-000000000003';
const demoId = (idNamespace: string, key: string) => v5(`${idNamespace}:${key}`, namespace);
const at = (instant: string) => DateTime.toDateUtc(DateTime.makeUnsafe(instant));
const customer = Schema.decodeUnknownSync(SalesDemoCustomerFixtureSchema)({
  city: 'Brno',
  counterpartyId: '00000000-0000-4000-8000-000000000100',
  domain: 'example.test',
  ico: '12345678',
  mailbox: 'firma',
  membershipInvocationId: '00000000-0000-4000-8000-000000000300',
  name: 'Firma Test s.r.o.',
  partyId: '00000000-0000-4000-8000-000000000200',
  phone: '+420123456789',
  postalCode: '60200',
  profileInvocationId: '00000000-0000-4000-8000-000000000400',
  segmentCode: customerSegmentDefinitions[0].businessCode,
  street: 'Testovací 1',
});

it('projects a synthetic organization customer as a business name, never a person name', () => {
  const ids = salesDemoSeedIds(customer, demoId);
  const party = salesDemoOrganizationParty({
    businessName: customer.name,
    now: at('2026-11-07T12:00:00.000Z'),
    partyId: ids.party,
    since: at('2024-03-04T08:00:00.000Z'),
    tenantId: '00000000-0000-4000-8000-000000000005',
  });
  expect(party.currentType).toBe('ORGANIZATION');
  expect(party.businessName).toBe(customer.name);
  expect(party.currentDisplayName).toBe(customer.name);
  expect(party).not.toHaveProperty('firstName');
  expect(party).not.toHaveProperty('lastName');
});

it('asserts BUSINESS_NAME under the business-name seed id and keeps the PARTY_TYPE evidence', () => {
  const ids = salesDemoSeedIds(customer, demoId);
  expect(ids).not.toHaveProperty('displayName');
  expect(ids.businessName).toBe(demoId('party.fact-assertion', 'ico-12345678:BUSINESS_NAME'));

  const facts = salesDemoOrganizationIdentityFacts({ customer, ids, reference: 'sales-demo:ico-12345678' });
  expect(facts.map(({ factKind }) => factKind)).toEqual(['PARTY_TYPE', 'BUSINESS_NAME']);
  expect(facts[0].evidenceEvaluation.subjectEligible).toBe(true);
  expect(facts[1].assertionId).toBe(ids.businessName);
  expect(facts[1].normalizedValue).toBe(customer.name);
});
