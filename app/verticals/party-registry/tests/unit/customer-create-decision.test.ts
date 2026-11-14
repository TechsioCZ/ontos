import { Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CustomerListItemSchema } from '../../shared/apis/customer-list.ts';
import { PartyRefSchema } from '../../shared/resources/party.ts';
import {
  decideAmbiguousCustomerCreate,
  existingCustomerWithCompanyId,
} from '../../src/api/customer-create-decision.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '40000000-0000-4000-8000-000000000001';
const counterpartyId = '30000000-0000-4000-8000-000000000001';
const partyRef = Schema.decodeSync(PartyRefSchema)({
  moduleId: 'party.registry',
  resourceId: partyId,
  resourceType: 'party.registry.party',
  tenantId,
});

const customer = (companyId: string | null, status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE') =>
  Schema.decodeSync(CustomerListItemSchema)({
    city: null,
    companyId,
    counterpartyId,
    counterpartyRef: {
      moduleId: 'party.registry',
      resourceId: counterpartyId,
      resourceType: 'party.registry.counterparty',
      tenantId,
    },
    createdAt: '2026-01-05T08:00:00.000Z',
    displayName: 'Strojírny Vysočina s.r.o.',
    email: null,
    partyId,
    partyRef,
    partyRevision: 1,
    phone: null,
    status,
    vatId: null,
  });

it('reuses the active customer that already carries the IČO', () => {
  const found = existingCustomerWithCompanyId([customer('12345678'), customer('27082440')], ' 2708 2440 ');
  expect(Option.getOrNull(found)?.companyId).toBe('27082440');
});

it('creates anew for a fresh IČO, a missing IČO, or only an archived duplicate', () => {
  expect(Option.isNone(existingCustomerWithCompanyId([customer('27082440')], '45317054'))).toBe(true);
  expect(Option.isNone(existingCustomerWithCompanyId([customer('27082440')], ''))).toBe(true);
  expect(Option.isNone(existingCustomerWithCompanyId([customer('27082440')], '  '))).toBe(true);
  expect(Option.isNone(existingCustomerWithCompanyId([customer('27082440', 'ARCHIVED')], '27082440'))).toBe(true);
  expect(Option.isNone(existingCustomerWithCompanyId([customer(null)], '27082440'))).toBe(true);
});

it('creates a new Party when the open duplicate case lists no candidate Party', () => {
  expect(decideAmbiguousCustomerCreate({ candidateParties: [], lifecycleState: 'OPEN' })).toBe('CREATE_NEW');
});

it('keeps a duplicate case with a candidate Party for an Identity Reviewer', () => {
  expect(decideAmbiguousCustomerCreate({ candidateParties: [partyRef], lifecycleState: 'OPEN' })).toBe('NEEDS_REVIEW');
});

it('never resolves a duplicate case that is no longer open', () => {
  expect(decideAmbiguousCustomerCreate({ candidateParties: [], lifecycleState: 'RESOLVED' })).toBe('NEEDS_REVIEW');
  expect(decideAmbiguousCustomerCreate({ candidateParties: [], lifecycleState: 'NEEDS_EVIDENCE' })).toBe(
    'NEEDS_REVIEW',
  );
});
