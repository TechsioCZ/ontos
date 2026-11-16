import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  COUNTERPARTY_IDENTITIES_MAX_REFS,
  CounterpartyIdentitiesRequestSchema,
  CounterpartyIdentitySchema,
} from '../../shared/apis/counterparty-identities.ts';
import { counterpartyIdentitiesRead } from '../../src/api/counterparty-identities.read.ts';
import { customerListRead } from '../../src/api/customer-list.read.ts';
import { listCounterpartyIdentityRecords } from '../../src/services/customer-list-persistence.service.ts';
import { customerListSelectHarness as harness } from '../support/customer-list-select-harness.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const supplierId = '30000000-0000-4000-8000-000000000001';
const archivedId = '30000000-0000-4000-8000-000000000002';
const supplierPartyId = '40000000-0000-4000-8000-000000000001';
const archivedPartyId = '40000000-0000-4000-8000-000000000002';
const ref = (index: number) => ({
  moduleId: 'party.registry',
  resourceId: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  resourceType: 'party.registry.counterparty',
  tenantId,
});
const refs = (count: number) => Array.from({ length: count }, (_, index) => ref(index + 1));
const date = (instant: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(instant));

it.effect('reads named supplier-only and archived Counterparties of the company, with no role or archive filter', () =>
  Effect.gen(function* testIdentities() {
    const { conditions, selectedTables, transaction } = harness([
      [
        {
          archivedAt: null,
          counterpartyId: supplierId,
          createdAt: date('2026-01-05T08:00:00.000Z'),
          partyId: supplierPartyId,
        },
        {
          archivedAt: date('2026-03-01T00:00:00.000Z'),
          counterpartyId: archivedId,
          createdAt: date('2026-01-06T08:00:00.000Z'),
          partyId: archivedPartyId,
        },
      ],
      [
        { archivedAt: null, currentDisplayName: 'Dodavatel energie a.s.', partyId: supplierPartyId, revision: 1 },
        { archivedAt: null, currentDisplayName: 'Bývalý zákazník s.r.o.', partyId: archivedPartyId, revision: 2 },
      ],
      [
        { identifierTypeKey: 'ICO', normalizedValue: '27082440', partyId: supplierPartyId },
        { identifierTypeKey: 'CZ_DIC', normalizedValue: 'CZ27082440', partyId: supplierPartyId },
        { identifierTypeKey: 'ICO', normalizedValue: '45274649', partyId: archivedPartyId },
      ],
      [{ city: 'Brno', contactPointType: 'ADDRESS', displayValue: null, partyId: supplierPartyId }],
    ]);

    const items = yield* listCounterpartyIdentityRecords(
      transaction,
      { legalEntityId, tenantId },
      [supplierId, archivedId, supplierId],
      (partyIds) => Effect.succeed(new Map(partyIds.map((partyId) => [partyId, partyId]))),
    );

    // No join with role periods: a supplier, a former customer or a counterparty with no role at all is found.
    expect(selectedTables).toEqual(['counterparties', 'parties', 'party_official_identifiers', 'party_contact_points']);
    const [condition] = conditions;
    expect(condition).toBeDefined();
    const counterpartyQuery = new PgDialect().sqlToQuery(condition ?? sql``);
    expect(counterpartyQuery.sql).toContain('"tenant_id" = $1');
    expect(counterpartyQuery.sql).toContain('"legal_entity_id" = $2');
    expect(counterpartyQuery.sql).toContain('"counterparty_id" in ($3, $4)');
    expect(counterpartyQuery.sql).not.toContain('archived_at');
    expect(counterpartyQuery.params).toEqual([tenantId, legalEntityId, supplierId, archivedId]);
    expect(
      items.map(({ city, companyId, counterpartyId, displayName, status, vatId }) => ({
        city,
        companyId,
        counterpartyId,
        displayName,
        status,
        vatId,
      })),
    ).toEqual([
      {
        city: 'Brno',
        companyId: '27082440',
        counterpartyId: supplierId,
        displayName: 'Dodavatel energie a.s.',
        status: 'ACTIVE',
        vatId: 'CZ27082440',
      },
      {
        city: null,
        companyId: '45274649',
        counterpartyId: archivedId,
        displayName: 'Bývalý zákazník s.r.o.',
        status: 'ARCHIVED',
        vatId: null,
      },
    ]);
  }),
);

it.effect('asks nothing for an empty list of names', () =>
  Effect.gen(function* testEmpty() {
    const { selectedTables, transaction } = harness([]);
    const items = yield* listCounterpartyIdentityRecords(transaction, { legalEntityId, tenantId }, [], (partyIds) =>
      Effect.succeed(new Map(partyIds.map((partyId) => [partyId, partyId]))),
    );
    expect(items).toEqual([]);
    expect(selectedTables).toEqual([]);
  }),
);

it('bounds one call and answers only the identity fields the customer list shows', () => {
  expect(
    Schema.is(CounterpartyIdentitiesRequestSchema)({ counterpartyRefs: refs(COUNTERPARTY_IDENTITIES_MAX_REFS) }),
  ).toBe(true);
  expect(
    Schema.is(CounterpartyIdentitiesRequestSchema)({ counterpartyRefs: refs(COUNTERPARTY_IDENTITIES_MAX_REFS + 1) }),
  ).toBe(false);
  expect(Schema.is(CounterpartyIdentitiesRequestSchema)({ counterpartyRefs: [] })).toBe(false);
  expect(Object.keys(CounterpartyIdentitySchema.fields).toSorted()).toEqual([
    'city',
    'companyId',
    'counterpartyRef',
    'displayName',
    'status',
    'vatId',
  ]);
});

it('is declared at the customer list level: same scope, row filter, risk, selectors and placement', () => {
  const identities = counterpartyIdentitiesRead.descriptor;
  const customers = customerListRead.descriptor;
  expect(identities.accessDeclaration?.key).toBe('party.registry.counterparty-identity.list');
  const { key: _identitiesKey, ...identitiesAccess } = identities.accessDeclaration ?? { key: '' };
  const { key: _customersKey, ...customersAccess } = customers.accessDeclaration ?? { key: '' };
  expect(identitiesAccess).toEqual(customersAccess);
  expect([identities.accessKind, identities.legalEntityScope, identities.accessFieldGroups]).toEqual([
    customers.accessKind,
    customers.legalEntityScope,
    customers.accessFieldGroups,
  ]);
});
