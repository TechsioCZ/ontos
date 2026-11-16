import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { CustomerListResponseSchema } from '../../shared/apis/customer-list.ts';
import {
  assembleCustomerListItems,
  listCustomerRecords,
} from '../../src/services/customer-list-persistence.service.ts';
import { customerListSelectHarness as harness } from '../support/customer-list-select-harness.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const counterpartyId = '30000000-0000-4000-8000-000000000001';
const aliasPartyId = '40000000-0000-4000-8000-000000000001';
const canonicalPartyId = '40000000-0000-4000-8000-000000000002';
const date = (instant: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(instant));

const counterpartyRow = {
  archivedAt: null,
  counterpartyId,
  createdAt: date('2026-01-05T08:00:00.000Z'),
  partyId: aliasPartyId,
};

const partyRow = {
  archivedAt: null,
  currentDisplayName: 'Strojírny Vysočina s.r.o.',
  partyId: canonicalPartyId,
  revision: 3,
};

it('flattens identifiers and the first current channel of each type onto the canonical Party', () => {
  const items = assembleCustomerListItems(
    tenantId,
    [{ ...counterpartyRow, canonicalPartyId }],
    [partyRow],
    [
      { identifierTypeKey: 'CZ_DIC', normalizedValue: 'CZ27082440', partyId: canonicalPartyId },
      { identifierTypeKey: 'ICO', normalizedValue: '27082440', partyId: canonicalPartyId },
    ],
    [
      { city: null, contactPointType: 'EMAIL', displayValue: 'obchod@vysocina.cz', partyId: canonicalPartyId },
      { city: null, contactPointType: 'EMAIL', displayValue: 'fakturace@vysocina.cz', partyId: canonicalPartyId },
      { city: null, contactPointType: 'PHONE', displayValue: '+420 567 123 456', partyId: canonicalPartyId },
      { city: 'Jihlava', contactPointType: 'ADDRESS', displayValue: null, partyId: canonicalPartyId },
    ],
  );

  expect(items).toEqual([
    {
      city: 'Jihlava',
      companyId: '27082440',
      counterpartyId,
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: counterpartyId,
        resourceType: 'party.registry.counterparty',
        tenantId,
      },
      createdAt: '2026-01-05T08:00:00.000Z',
      displayName: 'Strojírny Vysočina s.r.o.',
      email: 'obchod@vysocina.cz',
      partyId: canonicalPartyId,
      partyRef: {
        moduleId: 'party.registry',
        resourceId: canonicalPartyId,
        resourceType: 'party.registry.party',
        tenantId,
      },
      partyRevision: 3,
      phone: '+420 567 123 456',
      status: 'ACTIVE',
      vatId: 'CZ27082440',
    },
  ]);
  expect(Schema.is(CustomerListResponseSchema)({ items })).toBe(true);
});

it('marks a customer archived when either its Counterparty or canonical Party is archived', () => {
  const archivedAt = date('2026-02-01T00:00:00.000Z');
  const items = assembleCustomerListItems(
    tenantId,
    [{ ...counterpartyRow, archivedAt, canonicalPartyId }],
    [partyRow],
    [],
    [],
  );

  expect(items?.map(({ email, status }) => ({ email, status }))).toEqual([{ email: null, status: 'ARCHIVED' }]);
});

it('fails closed when a Counterparty has no canonical Party row', () => {
  expect(assembleCustomerListItems(tenantId, [{ ...counterpartyRow, canonicalPartyId }], [], [], [])).toBeUndefined();
});

it.effect('reads scoped customers, resolves aliases, and loads Party facts in one bounded pass', () =>
  Effect.gen(function* testListCustomers() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-10-05T00:00:00.000Z')));
    const { selectedTables, transaction } = harness([
      [counterpartyRow, counterpartyRow],
      [partyRow],
      [{ identifierTypeKey: 'ICO', normalizedValue: '27082440', partyId: canonicalPartyId }],
      [{ city: 'Jihlava', contactPointType: 'ADDRESS', displayValue: null, partyId: canonicalPartyId }],
    ]);

    const items = yield* listCustomerRecords(
      transaction,
      { legalEntityId, tenantId },
      { includeArchived: false, limit: 50 },
      (partyIds) =>
        Effect.succeed(
          new Map(partyIds.map((partyId) => [partyId, partyId === aliasPartyId ? canonicalPartyId : partyId])),
        ),
    );

    expect(selectedTables).toEqual([
      'counterparties',
      'counterparty_role_periods',
      'parties',
      'party_official_identifiers',
      'party_contact_points',
    ]);
    expect(items.map(({ city, companyId, counterpartyId: id, partyId }) => ({ city, companyId, id, partyId }))).toEqual(
      [{ city: 'Jihlava', companyId: '27082440', id: counterpartyId, partyId: canonicalPartyId }],
    );
  }),
);

it.effect('returns an empty list without loading Party facts when no customer role is current', () =>
  Effect.gen(function* testEmptyList() {
    const { selectedTables, transaction } = harness([[]]);

    const items = yield* listCustomerRecords(
      transaction,
      { legalEntityId, tenantId },
      { includeArchived: true, limit: 10 },
      (partyIds) => Effect.succeed(new Map(partyIds.map((partyId) => [partyId, partyId]))),
    );

    expect(items).toEqual([]);
    expect(selectedTables).toEqual(['counterparties', 'counterparty_role_periods']);
  }),
);
